"""Mesh service API.

REST entrypoint for the mesh. Services and load tests are each one
CloudFormation stack, created from templates synthesized at build time; this
Lambda never runs CDK.

  POST   /services/{name}           {image?, port?, desiredCount?}
  GET    /services
  GET    /services/{name}           404 until the service is routable
  DELETE /services/{name}
  POST   /services/{name}/execute   {command}

  POST   /load/{target}             {tps, delayMs?, responseBytes?, requestBytes?, path?}
  GET    /load
  GET    /load/{target}             settings, status, and the latest results
  DELETE /load/{target}

`image` is "demo" (the default), "perf", or an image URI. A load test runs as
the service <target>-load until it is deleted; only "perf" targets honour
delayMs and responseBytes.

Services are read from the registry table, which each service's own stack
writes (Custom::MeshRegistryEntry), so nothing here can fall out of step with
CloudFormation.
"""
import json
import os
import re
import time

import boto3

SERVICE_TEMPLATE_URL = os.environ["SERVICE_TEMPLATE_URL"]
LOAD_TEMPLATE_URL = os.environ["LOAD_TEMPLATE_URL"]
IMAGES = {"demo": os.environ["DEMO_IMAGE"], "perf": os.environ["PERF_IMAGE"]}
REGISTRY_TABLE = os.environ["REGISTRY_TABLE"]
CLUSTER = os.environ["CLUSTER"]
MESH_DOMAIN = os.environ["MESH_DOMAIN"]
DEFAULT_PORT = 8080
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


def _service(item):
    name = item["name"]["S"]
    return {
        "name": name,
        "port": int(item["port"]["N"]),
        "hostname": f"{name}.{MESH_DOMAIN}",
        "status": "READY",
    }


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

def create_service(name, body):
    if not NAME_RE.match(name):
        raise BadRequest("name must match [a-z][a-z0-9-]{1,30}")
    if name.endswith("-load"):
        raise BadRequest("names ending in -load are reserved for load tests")
    image = body.get("image") or "demo"
    created = _create_stack(
        f"mesh-svc-{name}", SERVICE_TEMPLATE_URL,
        ServiceName=name,
        ImageUri=IMAGES.get(image, image),
        AppPort=_int(body, "port", DEFAULT_PORT, 1, 65535),
        DesiredCount=_int(body, "desiredCount", 1, 0, 10),
    )
    if not created:
        return _resp(409, {"error": f"service '{name}' already exists"})
    return _resp(202, {"name": name, "hostname": f"{name}.{MESH_DOMAIN}", "status": "CREATING"})


def get_service(name):
    """One GetItem.

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
    return _resp(200, _service(item))


def list_services():
    services = sorted(
        (
            _service(item)
            for page in ddb.get_paginator("scan").paginate(TableName=REGISTRY_TABLE)
            for item in page["Items"]
        ),
        key=lambda s: s["name"],
    )
    return _resp(200, {"count": len(services), "services": services})


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


def _window(line):
    """One 30-second result, as written by sample-services/perf/entrypoint.sh."""
    pct = {p["Percentile"]: round(p["Value"] * 1000, 2) for p in line["Percentiles"]}
    return {
        "at": line["StartTime"][:19] + "Z",
        "achievedTps": round(line["ActualQPS"], 1),
        "p50Ms": pct[50], "p90Ms": pct[90], "p99Ms": pct[99], "p999Ms": pct[99.9],
        "calls": line["Count"],
        "errors": line["Count"] - line["RetCodes"].get("200", 0),
    }


def _windows(target, since, limit=10):
    """The load generator's latest result windows, oldest first.

    Only results written after `since`, the current stack's creation time:
    a load test against the same target that was just deleted used the same
    log group name, and its results must not be reported as this one's.
    """
    windows = []
    try:
        pages = logs.get_paginator("filter_log_events").paginate(
            logGroupName=f"/ecs/{MESH_DOMAIN}/{target}-load",
            logStreamNamePrefix="app/",
            startTime=int(max(since.timestamp(), time.time() - 600) * 1000),
        )
        for page in pages:
            for event in page["events"]:
                try:
                    windows.append(_window(json.loads(event["message"])))
                except (ValueError, KeyError, TypeError):
                    pass  # not a result line
    except logs.exceptions.ResourceNotFoundException:
        pass  # the stack hasn't created its log group yet
    return windows[-limit:]


def create_load(target, body):
    row = _registry_row(target) if NAME_RE.match(target) else None
    if not row:
        return _resp(404, {"error": f"service '{target}' is not in the mesh"})
    path = body.get("path", "/")
    if not isinstance(path, str) or not PATH_RE.match(path):
        raise BadRequest("path must be a URL path, like /call/predict")
    created = _create_stack(
        f"mesh-load-{target}", LOAD_TEMPLATE_URL,
        Target=target,
        TargetPort=row["port"]["N"],
        ImageUri=IMAGES["perf"],
        Tps=_int(body, "tps", None, 1, 20000),
        DelayMs=_int(body, "delayMs", 0, 0, 10000),
        ResponseBytes=_int(body, "responseBytes", 0, 0, 262144),
        RequestBytes=_int(body, "requestBytes", 0, 0, 262144),
        Path=path,
    )
    if not created:
        return _resp(409, {"error": f"a load test against '{target}' is already running"})
    return _resp(202, {"target": target, "service": f"{target}-load", "status": "STARTING"})


def get_load(target):
    stack = _stack(f"mesh-load-{target}")
    if not stack:
        return _resp(404, {"error": f"no load test against '{target}'"})
    p = {x["ParameterKey"]: x["ParameterValue"] for x in stack["Parameters"]}
    windows = _windows(target, stack["CreationTime"])
    return _resp(200, {
        "target": target,
        "service": f"{target}-load",
        "status": _load_status(stack["StackStatus"], bool(windows)),
        "tps": int(p["Tps"]),
        "delayMs": int(p["DelayMs"]),
        "responseBytes": int(p["ResponseBytes"]),
        "requestBytes": int(p["RequestBytes"]),
        "path": p["Path"],
        "windows": windows,
    })


def list_loads():
    loads = sorted(
        (
            {"target": s["StackName"][len("mesh-load-"):], "status": _load_status(s["StackStatus"])}
            for page in cfn.get_paginator("list_stacks").paginate()
            for s in page["StackSummaries"]
            if s["StackName"].startswith("mesh-load-") and s["StackStatus"] != "DELETE_COMPLETE"
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
