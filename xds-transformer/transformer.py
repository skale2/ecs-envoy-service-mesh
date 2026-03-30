"""xDS Transformer – the control plane for this service mesh.

This module is the bridge between AWS service discovery (Cloud Map) and
Envoy's xDS configuration format. ECS tasks register themselves in Cloud
Map automatically; this transformer reads those registrations, converts
them into Envoy-native CDS/LDS/RDS YAML files, and uploads them to S3.
Envoy sidecars and the edge proxy watch S3 (via a file sync sidecar) to
pick up configuration changes.

The flow:  ECS task starts -> registers in Cloud Map -> this Lambda reads
Cloud Map -> generates Envoy xDS YAML -> writes to S3 -> Envoy reloads.
"""

import hashlib
import json
import logging
import os
import time

import boto3
import yaml

from envoy_config import (
    build_clusters_config,
    build_eds_config,
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
REGISTRY_KEY = "service-registry.json"

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

# In-memory checksum cache keyed by S3 object key -> MD5 hex digest.
# This avoids redundant S3 PutObject calls within a single Lambda invocation.
# Because the Lambda loops internally (see handler()), the same process may
# run multiple discovery cycles — the cache ensures we only write when the
# generated YAML actually changes between cycles.
_checksum_cache: dict[str, str] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def _upload_if_changed(key: str, content: dict) -> bool:
    """Serialize *content* to YAML and upload to S3 only if the content changed.

    Lazy-write pattern: we hash the serialized YAML and compare against the
    last-known hash in _checksum_cache. If the mesh is stable (no tasks
    scaling in/out), most cycles produce identical configs — this avoids
    unnecessary S3 writes and the Envoy config reloads they would trigger.
    """
    raw = yaml.dump(content, default_flow_style=False).encode("utf-8")
    digest = _md5(raw)

    if _checksum_cache.get(key) == digest:
        return False

    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=raw,
        ContentType="application/x-yaml",
    )
    _checksum_cache[key] = digest
    logger.info("Uploaded %s (md5=%s)", key, digest)
    return True


def read_service_registry() -> dict:
    """Download and parse the service registry JSON from S3."""
    try:
        response = s3_client.get_object(Bucket=S3_BUCKET, Key=REGISTRY_KEY)
        body = response["Body"].read()
        return json.loads(body)
    except Exception:
        logger.exception("Failed to read service registry from s3://%s/%s", S3_BUCKET, REGISTRY_KEY)
        return {}


# ---------------------------------------------------------------------------
# Cloud Map discovery
# ---------------------------------------------------------------------------

def _list_cloudmap_service_ids() -> dict[str, str]:
    """Return a mapping of service name -> Cloud Map service ID.

    ECS services automatically register their tasks in Cloud Map when the
    ECS service definition includes `serviceRegistries` (set via CDK's
    `cloudMapOptions` or `associateCloudMapService`). Each ECS service
    creates a corresponding Cloud Map service within our namespace.
    """
    service_map: dict[str, str] = {}
    paginator = sd_client.get_paginator("list_services")
    for page in paginator.paginate(
        Filters=[{"Name": "NAMESPACE_ID", "Values": [CLOUDMAP_NAMESPACE_ID]}]
    ):
        for svc in page.get("Services", []):
            service_map[svc["Name"]] = svc["Id"]
    return service_map


def _list_instances(service_id: str) -> list[dict]:
    """Return instances for a given Cloud Map service ID.

    ECS registers each running task as a Cloud Map instance with these
    attributes:
      - AWS_INSTANCE_IPV4: the task's private IP (from the awsvpc ENI)
      - AWS_INSTANCE_PORT: the container port (defaults to 8080 if unset)
      - AVAILABILITY_ZONE: the AZ where the task is running (e.g. us-east-1a)
    We extract these to build Envoy endpoint definitions.
    """
    instances: list[dict] = []
    paginator = sd_client.get_paginator("list_instances")
    for page in paginator.paginate(ServiceId=service_id):
        for inst in page.get("Instances", []):
            attrs = inst.get("Attributes", {})
            ip = attrs.get("AWS_INSTANCE_IPV4")
            port = attrs.get("AWS_INSTANCE_PORT", "8080")
            az = attrs.get("AVAILABILITY_ZONE", "unknown")
            if ip:
                instances.append({"ip": ip, "port": int(port), "az": az})
    return instances


def discover_endpoints(service_names: list[str]) -> dict[str, list[dict]]:
    """Discover live endpoints for all requested services via Cloud Map.

    This is the core bridge between the AWS world and the Envoy world:
    Cloud Map holds the source of truth for which ECS tasks are running
    (IP + port + AZ), and Envoy needs that information as endpoint
    addresses inside STATIC cluster definitions. This function reads
    the former and returns data shaped for the latter.
    """
    endpoints_map: dict[str, list[dict]] = {}
    try:
        cm_services = _list_cloudmap_service_ids()
    except Exception:
        logger.exception("Failed to list Cloud Map services")
        return endpoints_map

    for name in service_names:
        sid = cm_services.get(name)
        if not sid:
            logger.warning("Service %s not found in Cloud Map", name)
            endpoints_map[name] = []
            continue
        try:
            endpoints_map[name] = _list_instances(sid)
            logger.info("Discovered %d endpoints for %s", len(endpoints_map[name]), name)
        except Exception:
            logger.exception("Failed to list instances for %s (id=%s)", name, sid)
            endpoints_map[name] = []

    return endpoints_map


# ---------------------------------------------------------------------------
# Config generation & upload
# ---------------------------------------------------------------------------

def generate_and_upload(registry: dict) -> None:
    """Generate xDS configs for every service and the edge proxy."""
    services = registry.get("services", {})
    if not services:
        logger.warning("Service registry is empty – nothing to generate")
        return

    all_service_names = list(services.keys())

    # Discover endpoints for every service.
    endpoints_map = discover_endpoints(all_service_names)

    # Both sidecar proxies and the edge proxy use the exact same xDS config
    # shape (CDS + EDS + LDS + RDS). The only difference is the dependency list:
    # a sidecar only knows about the services its app calls (a subset), while
    # the edge proxy knows about all services (so it can route external traffic
    # to any of them). This lets us use one function for both cases.
    def _upload_service_configs(name, deps, s3_prefix):
        dep_endpoints = {dep: endpoints_map.get(dep, []) for dep in deps}
        _upload_if_changed(f"{s3_prefix}/cds.yaml", build_clusters_config(deps, dep_endpoints))
        _upload_if_changed(f"{s3_prefix}/eds.yaml", build_eds_config(dep_endpoints))
        _upload_if_changed(f"{s3_prefix}/lds.yaml", build_listeners_config(name))
        _upload_if_changed(f"{s3_prefix}/rds.yaml", build_routes_config(deps, MESH_DOMAIN))

    # ---- Per-service sidecar configs ----
    for svc_name, svc_info in services.items():
        deps = svc_info.get("dependencies", [])
        _upload_service_configs(svc_name, deps, f"services/{svc_name}")

    # ---- Edge proxy configs (identical shape, all services as deps) ----
    _upload_service_configs("edge-proxy", all_service_names, "edge-proxy")


# ---------------------------------------------------------------------------
# Lambda handler
# ---------------------------------------------------------------------------

def handler(event, context):
    """AWS Lambda entry point (invoked by EventBridge on a schedule).

    EventBridge's minimum schedule rate is 1 minute, but we want endpoint
    updates roughly every 10 seconds for fast scaling response. To work
    around this, the Lambda loops internally — each invocation runs multiple
    discovery-and-upload cycles, sleeping 10s between them, until the
    remaining execution time drops below 15s. This gives us ~5 cycles per
    1-minute invocation without needing a long-running process.
    """
    if not S3_BUCKET:
        raise RuntimeError("S3_BUCKET environment variable is required")
    if not CLOUDMAP_NAMESPACE_ID:
        raise RuntimeError("CLOUDMAP_NAMESPACE_ID environment variable is required")

    cycles = 0
    while context.get_remaining_time_in_millis() > 15_000:
        try:
            registry = read_service_registry()
            if registry:
                generate_and_upload(registry)
                cycles += 1
        except Exception:
            logger.exception("Error in transformer cycle")
        time.sleep(10)

    return {"statusCode": 200, "body": f"Completed {cycles} cycles"}
