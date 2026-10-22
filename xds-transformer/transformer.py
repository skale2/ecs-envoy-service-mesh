"""xDS Transformer – the control plane for this service mesh.

This module is the bridge between AWS service discovery (AWS Cloud Map) and
Envoy's xDS configuration format. ECS tasks register themselves in AWS Cloud
Map automatically; this transformer reads those registrations, converts them
into Envoy-native CDS/LDS/RDS YAML files, and uploads them to S3.
Envoy sidecars and the edge proxy watch S3 (via a file sync sidecar) to
pick up configuration changes.

The flow:  ECS task starts -> registers in AWS Cloud Map -> this AWS Lambda function reads
AWS Cloud Map -> generates Envoy xDS YAML -> writes to S3 -> Envoy reloads.
"""

import hashlib
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import boto3
import yaml

from envoy_config import (
    build_clusters_config,
    build_listeners_config,
    build_routes_config,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

S3_BUCKET = os.environ.get("S3_BUCKET", "")
CLOUDMAP_NAMESPACE_ID = os.environ.get("CLOUDMAP_NAMESPACE_ID", "")
MESH_DOMAIN = os.environ.get("MESH_DOMAIN", "mesh.local")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
REGISTRY_TABLE = os.environ.get("REGISTRY_TABLE", "")
# Matches DEFAULT_APP_PORT in the CDK constants; only used as a fallback
# for an AWS Cloud Map instance registered without an explicit port.
DEFAULT_APP_PORT = 8080

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# AWS clients
# ---------------------------------------------------------------------------

s3_client = boto3.client("s3", region_name=AWS_REGION)
sd_client = boto3.client("servicediscovery", region_name=AWS_REGION)
ddb_client = boto3.client("dynamodb", region_name=AWS_REGION)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _upload_if_changed(key: str, content: dict) -> bool:
    """Write *content* to S3 as YAML, but only if the bytes differ.

    An object's S3 eTag is the MD5 of its content, and the sidecars decide
    whether to reload by watching that eTag. So asking S3 what it already
    holds is both the cheapest way to skip a redundant write and exactly the
    comparison the consumers make — a HeadObject in place of a PutObject,
    and no new object version for a config that did not change.
    """
    raw = yaml.dump(content, Dumper=yaml.CSafeDumper, default_flow_style=False).encode("utf-8")
    digest = hashlib.md5(raw, usedforsecurity=False).hexdigest()

    try:
        current = s3_client.head_object(Bucket=S3_BUCKET, Key=key)["ETag"].strip('"')
        if current == digest:
            return False
    except s3_client.exceptions.ClientError:
        pass  # not there yet, so write it

    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=raw,
        ContentType="application/x-yaml",
    )
    logger.info("Uploaded %s (md5=%s)", key, digest)
    return True


# Everything this function does is network-bound, and the work per service is
# independent, so it is all run through one pool. This is what keeps a mesh of
# several hundred services inside a single invocation: serially, a few thousand
# round-trips at ~20ms each would not finish, and concurrency is pinned to 1 so
# there is no second invocation to pick up the slack. botocore clients are
# thread-safe for concurrent calls, so the module-level clients are shared.
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


def read_service_registry() -> dict[str, int]:
    """Return {service name: app port} for every service in the mesh.

    Both entrypoints write into this one table, so there is nothing to merge:
    a service declared in CDK and a service created by POST /services are the
    same kind of row and this function can't tell them apart.
    """
    return {
        item["name"]["S"]: int(item["port"]["N"])
        for item in _paginate(ddb_client, "scan", "Items", TableName=REGISTRY_TABLE)
    }


# ---------------------------------------------------------------------------
# AWS Cloud Map discovery
# ---------------------------------------------------------------------------

def discover_endpoints(service_names: list[str]) -> dict[str, list[dict]]:
    """Return {service name: [{ip, port, az}, ...]} from AWS Cloud Map.

    This is the bridge between the AWS world and the Envoy world. ECS
    registers each running task in AWS Cloud Map as it starts, tagged with
    the task's awsvpc ENI address (AWS_INSTANCE_IPV4), its container port,
    and its AZ. Envoy wants exactly that, shaped as endpoints inside a
    cluster. This reads the former and returns the latter.

    A service with no live tasks maps to an empty list rather than being
    omitted, so it still gets a cluster with no endpoints — callers then get
    a clean 503 from Envoy instead of a DNS or routing failure.
    """
    service_ids = {
        svc["Name"]: svc["Id"]
        for svc in _paginate(
            sd_client, "list_services", "Services",
            Filters=[{"Name": "NAMESPACE_ID", "Values": [CLOUDMAP_NAMESPACE_ID]}],
        )
    }

    def instances_of(name: str) -> list[dict]:
        service_id = service_ids.get(name)
        if not service_id:
            # Registered but ECS has not placed a task yet. An empty list is
            # the right answer, not an error.
            logger.warning("Service %s is registered but not yet in AWS Cloud Map", name)
            return []
        return [
            {
                "ip": attrs["AWS_INSTANCE_IPV4"],
                "port": int(attrs.get("AWS_INSTANCE_PORT", DEFAULT_APP_PORT)),
                "az": attrs.get("AVAILABILITY_ZONE", "unknown"),
            }
            for inst in _paginate(sd_client, "list_instances", "Instances", ServiceId=service_id)
            if (attrs := inst.get("Attributes", {})).get("AWS_INSTANCE_IPV4")
        ]

    return dict(zip(service_names, _in_parallel(instances_of, service_names)))


# ---------------------------------------------------------------------------
# Config generation & upload
# ---------------------------------------------------------------------------


def generate_and_upload(service_names: list[str]) -> None:
    """Write the mesh's Envoy config to S3.

    Three files for the whole mesh, however many services it holds.
    
    That falls out of the mesh being fully connected: every proxy wants a
    cluster for every service, so every proxy wants the same config. Giving
    each service its own copy would mean building and uploading N copies of
    an N-service config on every change — quadratic work to express a fact
    that fits in one file. The edge proxy reads the same three files; it is
    not a special case either.

    A proxy's identity is not in here. It arrives through the bootstrap,
    which stamps mesh.service on every metric.
    """
    endpoints = discover_endpoints(service_names)

    files = [
        ("mesh/cds.yaml", build_clusters_config(service_names, endpoints)),
        ("mesh/lds.yaml", build_listeners_config()),
        ("mesh/rds.yaml", build_routes_config(service_names, MESH_DOMAIN)),
    ]
    written = _in_parallel(lambda f: _upload_if_changed(*f), files)
    logger.info("Wrote %d of %d xDS files for %d services",
                sum(written), len(files), len(service_names))


# ---------------------------------------------------------------------------
# AWS Lambda handler
# ---------------------------------------------------------------------------

def handler(event, context):
    """Regenerate every service's Envoy config from the current state.

    One pass per invocation, and the same pass whatever woke it up. There are
    three triggers, and none of them need handling differently because the
    function doesn't read the event at all — it re-derives the whole mesh
    from the registry and AWS Cloud Map every time:

      - ECS task state changes, which is what actually moves endpoints
        around. A deployment, a scale-out, a host failure: ECS emits an
        event, and the new task IPs are in Cloud Map by the time we look.
      - Registry writes, so a newly created service gets config immediately
        instead of waiting for anything.
      - A one-minute schedule, as a backstop for a dropped event.

    Deriving everything rather than applying a delta is what keeps this
    simple: it makes the function idempotent, which is what lets all three
    triggers share one code path and lets a missed event cost nothing but
    latency.
    """
    for name, value in [
        ("S3_BUCKET", S3_BUCKET),
        ("CLOUDMAP_NAMESPACE_ID", CLOUDMAP_NAMESPACE_ID),
        ("REGISTRY_TABLE", REGISTRY_TABLE),
    ]:
        if not value:
            raise RuntimeError(f"{name} environment variable is required")

    services = read_service_registry()
    # No early return for an empty registry: that is a real state, reached by
    # deleting the last service, and it has to be written out. Skipping it
    # would leave the deleted service's cluster in S3 indefinitely.
    generate_and_upload(sorted(services))
    return {"statusCode": 200, "body": f"generated config for {len(services)} services"}
