"""Mesh service API.

REST entrypoint for the mesh. Services and load tests are each one
CloudFormation stack, created from templates synthesized at build time; this
Lambda never runs CDK.

  POST   /services/{name}           {image?, port?, tasks?, proxy?}
  GET    /services
  GET    /services/{name}           404 until the service is routable
  PATCH  /services/{name}           {tasks}
  DELETE /services/{name}
  POST   /services/{name}/execute   {command}

  POST   /load/{target}             {tps, delayMs?, responseBytes?, requestBytes?, path?}
  GET    /load                      every test and its settings
  GET    /load/{target}             settings, status, and the latest results
  DELETE /load/{target}

`image` is "demo" (the sample app, the default) or an image URI. `proxy` is
"envoy" (the default: an Envoy sidecar in every task) or "nlb" (no sidecar,
and an NLB of the service's own in front), for comparing the two. A load
test runs as the service <target>-load, on as many tasks as its TPS needs,
until it is deleted. Its delayMs and responseBytes are applied by whichever
service ends the request's path, in the sample app.

Services are read from the registry table, which each service's own stack
writes (Custom::MeshRegistryEntry), so nothing here can fall out of step with
CloudFormation.
"""
import json
import math
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timezone

import boto3

SERVICE_TEMPLATE_URL = os.environ["SERVICE_TEMPLATE_URL"]
NLB_SERVICE_TEMPLATE_URL = os.environ["NLB_SERVICE_TEMPLATE_URL"]
LOAD_TEMPLATE_URL = os.environ["LOAD_TEMPLATE_URL"]
DEMO_IMAGE = os.environ["DEMO_IMAGE"]
LOAD_IMAGE = os.environ["LOAD_IMAGE"]
REGISTRY_TABLE = os.environ["REGISTRY_TABLE"]
CLUSTER = os.environ["CLUSTER"]
MESH_DOMAIN = os.environ["MESH_DOMAIN"]
DEFAULT_PORT = 8080
# Most tasks one service or load test can have; the templates' DesiredCount
# and Tasks parameters say the same.
MAX_TASKS = 200
# The templates enforce the same patterns; checking here turns a failed
# stack into a 400.
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,30}$")
PATH_RE = re.compile(r"^/[A-Za-z0-9/._-]*$")

cfn = boto3.client("cloudformation")
ddb = boto3.client("dynamodb")
ecs = boto3.client("ecs")
logs = boto3.client("logs")
ssm = boto3.client("ssm")


class BadRequest(Exception):
    pass


def _resp(code, body):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _int(body, key, default, lo, hi):
    value = body.get(key, default)
    if value is None:
        raise BadRequest(f"{key} is required")
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise BadRequest(f"{key} must be an integer")
    if not lo <= value <= hi:
        raise BadRequest(f"{key} must be between {lo} and {hi}")
    return value


def _create_stack(stack_name, template_url, **params):
    """CreateStack; False if the stack already exists.

    This is also the duplicate check: stack names are unique per account, so
    two simultaneous creates of one name cannot both win. Failed stacks are
    kept (OnFailure=DO_NOTHING) so their events can be read; deleting the
    service or load test cleans them up.
    """
    try:
        cfn.create_stack(
            StackName=stack_name,
            TemplateURL=template_url,
            Parameters=[{"ParameterKey": k, "ParameterValue": str(v)} for k, v in params.items()],
            OnFailure="DO_NOTHING",
        )
    except cfn.exceptions.AlreadyExistsException:
        return False
    return True


def _stack(stack_name):
    try:
        return cfn.describe_stacks(StackName=stack_name)["Stacks"][0]
    except cfn.exceptions.ClientError:
        return None


def _registry_row(name):
    return ddb.get_item(TableName=REGISTRY_TABLE, Key={"name": {"S": name}}).get("Item")


def _service(item, counts):
    name = item["name"]["S"]
    return {
        "name": name,
        "port": int(item["port"]["N"]),
        "hostname": f"{name}.{MESH_DOMAIN}",
        "proxy": _proxy(item),
        "status": "READY",
        "tasks": counts.get(name),
    }


def _proxy(item):
    return item.get("proxy", {}).get("S", "envoy")


def _template(proxy):
    return NLB_SERVICE_TEMPLATE_URL if proxy == "nlb" else SERVICE_TEMPLATE_URL


def _task_counts(names):
    """{name: {desired, running}} from ECS, ten services to a call."""
    counts = {}
    for i in range(0, len(names), 10):
        page = ecs.describe_services(cluster=CLUSTER, services=[f"service-{n}" for n in names[i:i + 10]])
        for svc in page["services"]:
            counts[svc["serviceName"][len("service-"):]] = {
                "desired": svc["desiredCount"], "running": svc["runningCount"]}
    return counts


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

def create_service(name, body):
    if not NAME_RE.match(name):
        raise BadRequest("name must match [a-z][a-z0-9-]{1,30}")
    if name.endswith("-load"):
        raise BadRequest("names ending in -load are reserved for load tests")
    image = body.get("image") or "demo"
    proxy = body.get("proxy") or "envoy"
    if proxy not in ("envoy", "nlb"):
        raise BadRequest('proxy must be "envoy" or "nlb"')
    created = _create_stack(
        f"mesh-svc-{name}", _template(proxy),
        ServiceName=name,
        ImageUri=DEMO_IMAGE if image == "demo" else image,
        AppPort=_int(body, "port", DEFAULT_PORT, 1, 65535),
        DesiredCount=_int(body, "tasks", 1, 1, MAX_TASKS),
    )
    if not created:
        return _resp(409, {"error": f"service '{name}' already exists"})
    return _resp(202, {"name": name, "hostname": f"{name}.{MESH_DOMAIN}", "proxy": proxy, "status": "CREATING"})


def get_service(name):
    """One GetItem, plus the service's task counts from ECS.

    The registry row is the service's last resource to be created, so the row
    existing *is* the readiness signal: present means routable, absent means
    still building or failed. That makes the client contract "poll until
    200", and keeps this a key lookup however many services exist.
    """
    item = _registry_row(name)
    if not item:
        return _resp(404, {
            "error": f"service '{name}' is not in the mesh",
            "detail": f"still creating, or the create failed; see stack mesh-svc-{name}",
        })
    return _resp(200, _service(item, _task_counts([name])))


def list_services():
    items = [item for page in ddb.get_paginator("scan").paginate(TableName=REGISTRY_TABLE)
             for item in page["Items"]]
    counts = _task_counts([item["name"]["S"] for item in items])
    services = sorted((_service(item, counts) for item in items), key=lambda s: s["name"])
    return _resp(200, {"count": len(services), "services": services})


def scale_service(name, body):
    """Change how many tasks a service runs, in place.

    An update of the service's own stack, so CloudFormation stays the one
    record of what a service is. The update also moves the stack onto the
    current template, which is how a service created before a template change
    picks it up. If the new tasks don't fit on the fleet, the cluster's
    capacity provider adds instances for them.
    """
    stack = _stack(f"mesh-svc-{name}")
    if not stack:
        return _resp(404, {"error": f"service '{name}' is not managed by this API"})
    row = _registry_row(name)
    if not row:
        return _resp(409, {"error": f"service '{name}' is still being created; try again once it is ready"})
    tasks = _int(body, "tasks", None, 1, MAX_TASKS)
    template = _template(_proxy(row))
    # Only parameters the current template still declares can be carried over.
    current = {p["ParameterKey"] for p in cfn.get_template_summary(TemplateURL=template)["Parameters"]}
    params = [{"ParameterKey": p["ParameterKey"], "UsePreviousValue": True}
              for p in stack["Parameters"] if p["ParameterKey"] in current and p["ParameterKey"] != "DesiredCount"]
    try:
        cfn.update_stack(StackName=stack["StackName"], TemplateURL=template,
                         Parameters=params + [{"ParameterKey": "DesiredCount", "ParameterValue": str(tasks)}])
    except cfn.exceptions.ClientError as e:
        message = e.response["Error"]["Message"]
        if "No updates are to be performed" in message:
            return _resp(200, {"name": name, "tasks": tasks, "status": "UNCHANGED"})
        if "IN_PROGRESS" in message:
            return _resp(409, {"error": f"service '{name}' is already changing; try again once it settles"})
        raise
    return _resp(202, {"name": name, "tasks": tasks, "status": "SCALING"})


def delete_service(name):
    """Delete the stack; the stack takes its registry row with it."""
    if not _stack(f"mesh-svc-{name}"):
        # No stack: it never existed, or it is declared in CDK, where its
        # resources live in the mesh stack and this API can't remove them.
        return _resp(404, {"error": f"service '{name}' is not managed by this API"})
    cfn.delete_stack(StackName=f"mesh-svc-{name}")
    return _resp(202, {"name": name, "status": "DELETING"})


def execute_command(name, cmd):
    """Run a shell command in a service's app container.

    On the EC2 launch type a container's runtimeId is its Docker container ID
    on the host, and the host runs the SSM agent. So: find the task's host and
    the app container's ID, then `docker exec` there through SSM SendCommand.
    """
    if not cmd:
        raise BadRequest("command is required")

    try:
        task_arns = ecs.list_tasks(cluster=CLUSTER, serviceName=f"service-{name}",
                                   desiredStatus="RUNNING")["taskArns"]
    except ecs.exceptions.ServiceNotFoundException:
        return _resp(404, {"error": f"service '{name}' not found"})
    if not task_arns:
        return _resp(404, {"error": f"no running tasks for service '{name}'"})

    task = ecs.describe_tasks(cluster=CLUSTER, tasks=task_arns[:1])["tasks"][0]
    app = next((c for c in task["containers"] if c["name"] == "app"), {})
    if not app.get("runtimeId"):
        return _resp(409, {"error": "app container not ready yet"})
    instance_id = ecs.describe_container_instances(
        cluster=CLUSTER, containerInstances=[task["containerInstanceArn"]],
    )["containerInstances"][0]["ec2InstanceId"]

    # The command goes to `sh -c` inside the container as one argument, so
    # pipes and quoting behave as they would in a local shell.
    quoted = "'" + cmd.replace("'", "'\\''") + "'"
    command_id = ssm.send_command(
        InstanceIds=[instance_id],
        DocumentName="AWS-RunShellScript",
        Parameters={"commands": [f"docker exec {app['runtimeId']} sh -c {quoted}"]},
        TimeoutSeconds=30,
    )["Command"]["CommandId"]

    # API Gateway gives up at 29s, so stop polling well before that.
    deadline, inv = time.time() + 22, {}
    while time.time() < deadline:
        time.sleep(1.5)
        try:
            inv = ssm.get_command_invocation(CommandId=command_id, InstanceId=instance_id)
        except ssm.exceptions.InvocationDoesNotExist:
            continue
        if inv["Status"] in ("Success", "Failed", "Cancelled", "TimedOut"):
            break

    return _resp(200, {
        "service": name,
        "status": inv.get("Status", "Pending"),
        "exitCode": inv.get("ResponseCode"),
        "stdout": inv.get("StandardOutputContent", ""),
        "stderr": inv.get("StandardErrorContent", ""),
    })


# ---------------------------------------------------------------------------
# Load tests
# ---------------------------------------------------------------------------

def _load_status(stack_status, has_results=False):
    if stack_status.startswith("DELETE"):
        return "STOPPING"
    if "FAILED" in stack_status or "ROLLBACK" in stack_status:
        return "FAILED"
    # Results start arriving before CloudFormation finishes waiting on ECS.
    return "RUNNING" if has_results or stack_status.endswith("COMPLETE") else "STARTING"


def _load_plan(tps, delay_ms, payload_bytes):
    """How many load-generator tasks a test needs, the TPS each one holds,
    and the most one task is allowed.

    Measured on t3.xlarge, three tasks to a 4-vCPU host: the first thing to
    run out is a task's Envoy sidecar, not Fortio, which tops out near 10,000
    TPS. A task is budgeted 4,000 TPS for small payloads, at which its sidecar
    uses 1.2-1.9 cores, and less as payloads grow (16 KB costs ~20%, 64 KB
    ~40%). Spreading 100,000 TPS over 40 tasks instead of 25 left the p99
    unchanged, so the generators aren't what limits a test at that budget.
    The other limit is Fortio's 1,000 connections per task: it opens
    TPS x (delay + 20 ms) x 2 of them (sample-services/load/entrypoint.sh),
    which is what bounds a task against a slow target.
    """
    per_task = min(4000 / (1 + payload_bytes / 80_000), 500_000 / (delay_ms + 20))
    tasks = max(1, math.ceil(tps / per_task))
    return tasks, round(tps / tasks, 2), int(per_task)


def _epoch(stamp):
    return datetime.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()


def _percentile(buckets, p):
    """The p-th percentile, in ms, of [start s, end s, count] buckets."""
    want, seen = sum(n for _, _, n in buckets) * p / 100, 0
    for start, end, n in buckets:
        if n and seen + n >= want:
            return round((start + (end - start) * (want - seen) / n) * 1000, 2)
        seen += n
    return round(buckets[-1][1] * 1000, 2) if buckets else 0


def _window(slot, lines):
    """One 30-second window from every task's result for it.

    Rates and counts add up; percentiles come from the tasks' histograms
    summed, since percentiles themselves can't be combined. A result without
    buckets is from a load test started before they were reported, which has
    one task, so its own percentiles are the window's.
    """
    calls = sum(line["Count"] for line in lines)
    if all("Buckets" in line for line in lines):
        buckets = sorted((b for line in lines for b in line["Buckets"]), key=lambda b: b[1])
        pct = {p: _percentile(buckets, p) for p in (50, 90, 99, 99.9)}
    else:
        pct = {p["Percentile"]: round(p["Value"] * 1000, 2) for p in lines[0]["Percentiles"]}
    return {
        "at": datetime.fromtimestamp(slot - 30, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "achievedTps": round(sum(line["ActualQPS"] for line in lines), 1),
        "p50Ms": pct[50], "p90Ms": pct[90], "p99Ms": pct[99], "p999Ms": pct[99.9],
        "calls": calls,
        "errors": calls - sum(line["RetCodes"].get("200", 0) for line in lines),
        "tasks": len(lines),
    }


def _windows(target, since, tasks, limit=10):
    """The load test's latest result windows, oldest first.

    Every task ends its windows on the same :00 and :30 boundaries, so the
    results are grouped by the boundary each one ended on. The newest window
    is left out until all `tasks` have reported it, which takes a few seconds.

    Only results written after `since`, the current stack's creation time:
    a load test against the same target that was just deleted used the same
    log group name, and its results must not be reported as this one's.
    """
    slots = defaultdict(list)
    try:
        pages = logs.get_paginator("filter_log_events").paginate(
            logGroupName=f"/ecs/{MESH_DOMAIN}/{target}-load",
            logStreamNamePrefix="app/",
            startTime=int(max(since.timestamp(), time.time() - (limit + 2) * 30) * 1000),
        )
        for page in pages:
            for event in page["events"]:
                try:
                    line = json.loads(event["message"])
                    end = _epoch(line["StartTime"]) + line.get("ActualDuration", 30e9) / 1e9
                    slots[round(end / 30) * 30].append(line)
                except (ValueError, KeyError, TypeError):
                    pass  # not a result line
    except logs.exceptions.ResourceNotFoundException:
        pass  # the stack hasn't created its log group yet
    windows = [_window(slot, lines) for slot, lines in sorted(slots.items())
               if len(lines) >= tasks or slot < time.time() - 20]
    return windows[-limit:]


def create_load(target, body):
    row = _registry_row(target) if NAME_RE.match(target) else None
    if not row:
        return _resp(404, {"error": f"service '{target}' is not in the mesh"})
    path = body.get("path", "/")
    if not isinstance(path, str) or not PATH_RE.match(path):
        raise BadRequest("path must be a URL path, like /call/predict")
    tps = _int(body, "tps", None, 1, 1_000_000)
    delay = _int(body, "delayMs", 0, 0, 10000)
    response, request = _int(body, "responseBytes", 0, 0, 262144), _int(body, "requestBytes", 0, 0, 262144)
    tasks, task_tps, per_task = _load_plan(tps, delay, response + request)
    if tasks > MAX_TASKS:
        raise BadRequest(f"{tps} TPS at these settings needs {tasks} load tasks, and a test can have "
                         f"{MAX_TASKS}: up to {per_task * MAX_TASKS} TPS")
    created = _create_stack(
        f"mesh-load-{target}", LOAD_TEMPLATE_URL,
        Target=target,
        TargetPort=row["port"]["N"],
        ImageUri=LOAD_IMAGE,
        Tps=tps,
        Tasks=tasks,
        TaskTps=task_tps,
        DelayMs=delay,
        ResponseBytes=response,
        RequestBytes=request,
        Path=path,
    )
    if not created:
        return _resp(409, {"error": f"a load test against '{target}' is already running"})
    return _resp(202, {"target": target, "service": f"{target}-load", "tps": tps, "tasks": tasks,
                       "taskTps": task_tps, "status": "STARTING"})


def _load_settings(stack):
    """What a load test was asked for, from its stack's parameters. Tests
    started before they ran on several tasks have no Tasks or TaskTps."""
    p = {x["ParameterKey"]: x["ParameterValue"] for x in stack["Parameters"]}
    return {
        "tps": int(p["Tps"]),
        "tasks": int(p.get("Tasks", 1)),
        "taskTps": float(p.get("TaskTps", p["Tps"])),
        "delayMs": int(p["DelayMs"]),
        "responseBytes": int(p["ResponseBytes"]),
        "requestBytes": int(p["RequestBytes"]),
        "path": p["Path"],
    }


def get_load(target):
    stack = _stack(f"mesh-load-{target}")
    if not stack:
        return _resp(404, {"error": f"no load test against '{target}'"})
    settings = _load_settings(stack)
    windows = _windows(target, stack["CreationTime"], settings["tasks"])
    return _resp(200, {
        "target": target,
        "service": f"{target}-load",
        "status": _load_status(stack["StackStatus"], bool(windows)),
        **settings,
        "windows": windows,
    })


def list_loads():
    """Every load test with its settings: one DescribeStacks pass, which
    returns parameters too, and no log reads, so it is cheap to poll."""
    loads = sorted(
        (
            {"target": s["StackName"][len("mesh-load-"):], "status": _load_status(s["StackStatus"]),
             **_load_settings(s)}
            for page in cfn.get_paginator("describe_stacks").paginate()
            for s in page["Stacks"]
            if s["StackName"].startswith("mesh-load-")
        ),
        key=lambda l: l["target"],
    )
    return _resp(200, {"count": len(loads), "loads": loads})


def delete_load(target):
    if not _stack(f"mesh-load-{target}"):
        return _resp(404, {"error": f"no load test against '{target}'"})
    cfn.delete_stack(StackName=f"mesh-load-{target}")
    return _resp(202, {"target": target, "status": "STOPPING"})


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

ROUTES = {
    ("POST", "/services/{name}"): lambda p, b: create_service(p["name"], b),
    ("GET", "/services"): lambda p, b: list_services(),
    ("GET", "/services/{name}"): lambda p, b: get_service(p["name"]),
    ("PATCH", "/services/{name}"): lambda p, b: scale_service(p["name"], b),
    ("DELETE", "/services/{name}"): lambda p, b: delete_service(p["name"]),
    ("POST", "/services/{name}/execute"): lambda p, b: execute_command(p["name"], b.get("command")),
    ("POST", "/load/{target}"): lambda p, b: create_load(p["target"], b),
    ("GET", "/load"): lambda p, b: list_loads(),
    ("GET", "/load/{target}"): lambda p, b: get_load(p["target"]),
    ("DELETE", "/load/{target}"): lambda p, b: delete_load(p["target"]),
}


def handler(event, context):
    route = ROUTES.get((event["httpMethod"], event["resource"]))
    if not route:
        return _resp(405, {"error": f"unsupported route {event['httpMethod']} {event['resource']}"})
    try:
        body = json.loads(event.get("body") or "{}")
        if not isinstance(body, dict):
            raise BadRequest("request body must be a JSON object")
        return route(event.get("pathParameters") or {}, body)
    except json.JSONDecodeError:
        return _resp(400, {"error": "request body must be JSON"})
    except BadRequest as e:
        return _resp(400, {"error": str(e)})
