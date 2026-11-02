"""GET /graph: every service in the mesh, and the calls between them.

Every Envoy counts the requests it sends to each upstream
(cluster.<target>.upstream_rq_total) and how many came back as 4xx or 5xx,
and keeps a histogram of how long they took (upstream_rq_time). Those are the
edges of the graph. This reads them off each task's Envoy admin endpoint and
returns them per task: the counts as running totals, the latency as Envoy's
p50 and p99 over its last stats interval.

The dashboard turns two successive polls into rates. It diffs per task, not
per service: a counter lives in one Envoy process and restarts from zero with
its task, so during a deploy a per-service sum would go backwards.

A service fronted by an NLB has no Envoy to read. Its app counts its own
calls in the same shape and serves them at /stats on its port, so those tasks
are read there instead, and their nodes are marked "nlb".

It runs in the VPC because that is the only place the admin endpoints can be
reached from.
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

import boto3

NAMESPACE_ID = os.environ["NAMESPACE_ID"]
REGISTRY_TABLE = os.environ["REGISTRY_TABLE"]
ADMIN_PORT = 9901
STAT = re.compile(r"^cluster\.([^.]+)\.upstream_rq_(total|4xx|5xx|time)$")
STATS_URL = "http://{}:%d/stats?usedonly&format=json&filter=%s" % (
    ADMIN_PORT, urllib.parse.quote(STAT.pattern))

sd = boto3.client("servicediscovery")
ddb = boto3.client("dynamodb")
pool = ThreadPoolExecutor(max_workers=64)


def _paginate(operation, key, **kwargs):
    for page in sd.get_paginator(operation).paginate(**kwargs):
        yield from page[key]


def _tasks():
    """(service, task IP) for every task in the mesh, load generators included."""
    services = list(_paginate("list_services", "Services",
                              Filters=[{"Name": "NAMESPACE_ID", "Values": [NAMESPACE_ID]}]))
    instances = pool.map(lambda s: list(_paginate("list_instances", "Instances", ServiceId=s["Id"])),
                         services)
    return [
        (service["Name"], inst["Attributes"]["AWS_INSTANCE_IPV4"])
        for service, insts in zip(services, instances)
        for inst in insts
        if "AWS_INSTANCE_IPV4" in inst["Attributes"]
    ]


def _stats(ip):
    """{target: {requests, errors, p50Ms, p99Ms}} from one task's Envoy."""
    try:
        with urllib.request.urlopen(STATS_URL.format(ip), timeout=2) as r:  # nosec B310 - fixed http URL to a task IP
            stats = json.load(r)["stats"]
    except (OSError, ValueError):
        return {}  # starting or stopping; it will be read on the next poll

    by_target = defaultdict(lambda: {"requests": 0, "errors": 0, "p50Ms": None, "p99Ms": None})
    for stat in stats:
        if "histograms" not in stat:
            target, kind = STAT.match(stat["name"]).groups()
            by_target[target]["requests" if kind == "total" else "errors"] += stat["value"]
            continue
        quantiles = stat["histograms"]["supported_quantiles"]
        p50, p99 = quantiles.index(50), quantiles.index(99)
        for histogram in stat["histograms"]["computed_quantiles"]:
            target = STAT.match(histogram["name"])[1]
            by_target[target]["p50Ms"] = histogram["values"][p50]["interval"]
            by_target[target]["p99Ms"] = histogram["values"][p99]["interval"]
    return by_target


def _app_stats(ip, port):
    """{target: {requests, errors, p50Ms, p99Ms}} from an app with no sidecar."""
    try:
        with urllib.request.urlopen(f"http://{ip}:{port}/stats", timeout=2) as r:  # nosec B310 - fixed http URL to a task IP
            return json.load(r)
    except (OSError, ValueError):
        return {}


def _without_sidecar():
    """{service: app port} for every service fronted by an NLB."""
    return {
        item["name"]["S"]: int(item["port"]["N"])
        for page in ddb.get_paginator("scan").paginate(TableName=REGISTRY_TABLE)
        for item in page["Items"]
        if item.get("proxy", {}).get("S") == "nlb"
    }


def _kind(name, nlbs):
    if name == "edge-proxy":
        return "edge"
    if name in nlbs:
        return "nlb"
    return "load" if name.endswith("-load") else "service"


def handler(event, context):
    tasks, nlbs = _tasks(), _without_sidecar()
    tasks_per_service = Counter(service for service, _ in tasks)

    def read(task):
        service, ip = task
        return _app_stats(ip, nlbs[service]) if service in nlbs else _stats(ip)

    counters = [
        {"source": source, "task": ip, "target": target, **values}
        for (source, ip), by_target in zip(tasks, pool.map(read, tasks))
        for target, values in by_target.items()
        # "passthrough" is traffic leaving the mesh; a target that is not a
        # node is a service that was just deleted.
        if target in tasks_per_service
    ]

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "at": int(time.time() * 1000),
            "nodes": [{"id": name, "kind": _kind(name, nlbs), "tasks": n}
                      for name, n in sorted(tasks_per_service.items())],
            "counters": counters,
        }),
    }
