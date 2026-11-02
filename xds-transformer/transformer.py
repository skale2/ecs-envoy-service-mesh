"""The mesh's control plane: one AWS Lambda function.

It reads which services exist from the registry (DynamoDB) and where their
tasks are from AWS Cloud Map, where ECS registers every task as it starts,
turns that into Envoy config (envoy_config.py), and writes it to S3. Every
proxy in the mesh polls those files and reloads when one changes
(envoy-sidecar/refresh.py).

    task starts -> ECS registers it in Cloud Map -> this function -> S3 -> every Envoy
"""

import hashlib
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import boto3
import yaml

from envoy_config import (
    build_clusters_config,
    build_endpoints_config,
    build_listeners_config,
    build_routes_config,
)

S3_BUCKET = os.environ.get("S3_BUCKET", "")
CLOUDMAP_NAMESPACE_ID = os.environ.get("CLOUDMAP_NAMESPACE_ID", "")
REGISTRY_TABLE = os.environ.get("REGISTRY_TABLE", "")
MESH_DOMAIN = os.environ.get("MESH_DOMAIN", "mesh.local")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
# Matches DEFAULT_APP_PORT in the CDK constants, for an AWS Cloud Map
# instance registered without a port.
DEFAULT_APP_PORT = 8080

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# botocore clients are safe to share across threads.
s3_client = boto3.client("s3", region_name=AWS_REGION)
sd_client = boto3.client("servicediscovery", region_name=AWS_REGION)
ddb_client = boto3.client("dynamodb", region_name=AWS_REGION)


# ---------------------------------------------------------------------------
# Lambda handler
# ---------------------------------------------------------------------------

def handler(event, context):
    """Re-derive the whole mesh's config, whatever woke the function up.

    Three things do, and none needs handling of its own, because the event
    is never read:

      - an ECS task state change: a deploy, a scale-out, a host failure. By
        the time this runs, the task's IP is in Cloud Map.
      - a registry write, so a new service gets config straight away.
      - a one-minute schedule, as a backstop for a dropped event.

    Deriving everything instead of applying a delta makes the function
    idempotent, so all three triggers share one code path and a missed event
    costs only latency.
    """
    for name, value in [("S3_BUCKET", S3_BUCKET), ("CLOUDMAP_NAMESPACE_ID", CLOUDMAP_NAMESPACE_ID),
                        ("REGISTRY_TABLE", REGISTRY_TABLE)]:
        if not value:
            raise RuntimeError(f"{name} environment variable is required")

    # An empty registry is written out too: deleting the last service has to
    # remove its cluster.
    services = read_service_registry()
    generate_and_upload(services)
    return {"statusCode": 200, "body": f"generated config for {len(services)} services"}


def generate_and_upload(services: dict[str, dict]) -> None:
    """Write the mesh's four files to S3, however many services it holds.

    They go up one at a time, endpoints first. Envoy rejects a cds.yaml that
    names a cluster whose endpoints file isn't there yet, so a new service's
    endpoints have to be in S3 before its cluster is; each sidecar reads the
    files in the opposite order (see envoy-sidecar/refresh.py).
    """
    names = sorted(services)
    nlbs = {name: (s["address"], s["port"]) for name, s in services.items() if s["address"]}
    endpoints = discover_endpoints([name for name in names if name not in nlbs])

    files = [
        ("mesh/eds.yaml", build_endpoints_config(endpoints, AWS_REGION)),
        ("mesh/cds.yaml", build_clusters_config(names, nlbs)),
        ("mesh/lds.yaml", build_listeners_config()),
        ("mesh/rds.yaml", build_routes_config(names, MESH_DOMAIN)),
    ]
    written = [_upload_if_changed(key, content) for key, content in files]
    logger.info("Wrote %d of %d xDS files for %d services", sum(written), len(files), len(names))


# ---------------------------------------------------------------------------
# Where the services are
# ---------------------------------------------------------------------------

def read_service_registry() -> dict[str, dict]:
    """{service: {port, address}} for every service in the mesh.

    A service declared in CDK and one created by POST /services are the same
    kind of row. `address` is set only for a service fronted by its own NLB,
    which callers reach through that address instead of its tasks.
    """
    return {
        item["name"]["S"]: {"port": int(item["port"]["N"]), "address": item.get("address", {}).get("S")}
        for item in _paginate(ddb_client, "scan", "Items", TableName=REGISTRY_TABLE)
    }


def discover_endpoints(service_names: list[str]) -> dict[str, list[dict]]:
    """{service: [{ip, port, az}, ...]} from AWS Cloud Map.

    ECS registers each running task with its ENI's address, its container
    port and its zone, and takes it out again as the task stops. A service
    with no tasks maps to an empty list, so it still gets a cluster, and its
    callers a clean 503 instead of a routing failure.
    """
    service_ids = {
        svc["Name"]: svc["Id"]
        for svc in _paginate(sd_client, "list_services", "Services",
                             Filters=[{"Name": "NAMESPACE_ID", "Values": [CLOUDMAP_NAMESPACE_ID]}])
    }

    def instances_of(name: str) -> list[dict]:
        if name not in service_ids:  # registered, but ECS hasn't created it in Cloud Map yet
            return []
        return [
            {
                "ip": attrs["AWS_INSTANCE_IPV4"],
                "port": int(attrs.get("AWS_INSTANCE_PORT", DEFAULT_APP_PORT)),
                "az": attrs.get("AVAILABILITY_ZONE", "unknown"),
            }
            for inst in _paginate(sd_client, "list_instances", "Instances", ServiceId=service_ids[name])
            if (attrs := inst.get("Attributes", {})).get("AWS_INSTANCE_IPV4")
        ]

    return dict(zip(service_names, _in_parallel(instances_of, service_names)))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _upload_if_changed(key: str, content: dict) -> bool:
    """Write *content* to S3 as YAML if it differs from what is there.

    A single-part object's ETag is the MD5 of its bytes, which is also how
    the sidecars tell whether they have the latest version. So a HEAD is
    enough to skip an unchanged file, and an unchanged file keeps its ETag,
    so every sidecar keeps getting 304s.
    """
    raw = yaml.dump(content, Dumper=_Dumper, sort_keys=False, default_flow_style=False).encode("utf-8")
    digest = hashlib.md5(raw, usedforsecurity=False).hexdigest()
    try:
        if s3_client.head_object(Bucket=S3_BUCKET, Key=key)["ETag"].strip('"') == digest:
            return False
    except s3_client.exceptions.ClientError:
        pass  # not there yet
    s3_client.put_object(Bucket=S3_BUCKET, Key=key, Body=raw, ContentType="application/x-yaml")
    logger.info("Uploaded %s (md5=%s)", key, digest)
    return True


class _Dumper(yaml.CSafeDumper):
    """Plain YAML in the order the builders write it, without anchors for
    the parts clusters share, so the files read like envoy_config.py."""

    def ignore_aliases(self, data):
        return True


# The Cloud Map reads are independent and network-bound, so they run in one
# pool. That keeps a mesh of several hundred services inside a single
# invocation; serially, a few thousand ~20 ms round trips would not finish.
_POOL_SIZE = 32


def _in_parallel(fn, items):
    """Map *fn* over *items* concurrently, preserving order."""
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(_POOL_SIZE, len(items))) as pool:
        return list(pool.map(fn, items))


def _paginate(client, operation: str, key: str, **kwargs):
    """Yield every item of a paginated AWS response."""
    for page in client.get_paginator(operation).paginate(**kwargs):
        yield from page.get(key, [])
