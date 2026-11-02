"""Keeps Envoy's config files in step with S3.

    refresh.py --once   fetch every file now; exit non-zero if any is missing
    refresh.py          check every 5 seconds, forever

Each check is a conditional GET: while a file is unchanged, S3 answers 304
Not Modified with no body, so a quiet mesh costs one small request per file.
A changed file is written beside the old one and renamed over it, because
Envoy reloads when it sees a file moved into place.

Envoy reads a cluster's endpoints from a file of its own, so eds.yaml, which
holds every service's, is split into eds/<service>.yaml here, and only the
services whose endpoints changed are rewritten.

It is one long-lived process, so a check costs a request rather than a
program start: a fresh process every 5 seconds costs about half a core.
"""
import hashlib
import os
import sys
import time

import botocore.session
import yaml
from botocore.exceptions import ClientError

BUCKET = os.environ["S3_BUCKET"]
REGION = os.environ["AWS_REGION"]
PREFIX = "mesh"
CONFIG_DIR = "/etc/envoy"
EDS_DIR = os.path.join(CONFIG_DIR, "eds")
# Clusters are fetched before endpoints, the reverse of the order the
# transformer writes them in, so any cluster in a cds.yaml this fetches has its
# endpoints in the eds.yaml it fetches next.
FILES = ("cds.yaml", "eds.yaml", "lds.yaml", "rds.yaml")
INTERVAL_S = 5

s3 = botocore.session.get_session().create_client("s3", region_name=REGION)


def refresh():
    """One pass over the files. Returns the names of the ones that changed."""
    new = {name: body for name in FILES if (body := fetch(name)) is not None}
    # Endpoints go in first: Envoy rejects a cds.yaml that names a cluster
    # whose endpoints file doesn't exist yet.
    if "eds.yaml" in new:
        split_endpoints(new["eds.yaml"])
    for name, body in new.items():
        install(os.path.join(CONFIG_DIR, name), body)
    return list(new)


def fetch(name):
    """The file's content if S3 has a newer version than ours, else None."""
    request = {"Bucket": BUCKET, "Key": f"{PREFIX}/{name}"}
    ours = _read(os.path.join(CONFIG_DIR, name))
    if ours is not None:
        # A single-part object's ETag is the MD5 of its content, so the copy
        # on disk names its own version.
        request["IfNoneMatch"] = '"%s"' % hashlib.md5(ours, usedforsecurity=False).hexdigest()
    try:
        return s3.get_object(**request)["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] in ("304", "NotModified"):
            return None
        raise


def split_endpoints(body):
    """Write eds/<service>.yaml for each service whose endpoints changed."""
    for assignment in yaml.safe_load(body)["resources"]:
        path = os.path.join(EDS_DIR, assignment["cluster_name"] + ".yaml")
        part = yaml.safe_dump({"resources": [assignment]}, sort_keys=False).encode()
        if _read(path) != part:
            install(path, part)


def install(path, body):
    """Write beside, then rename over: Envoy sees the move, never half a file."""
    with open(path + ".tmp", "wb") as f:
        f.write(body)
    os.replace(path + ".tmp", path)


def _read(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None


if __name__ == "__main__":
    os.makedirs(EDS_DIR, exist_ok=True)
    if "--once" in sys.argv:
        try:
            refresh()
        except Exception as e:
            sys.exit(f"config fetch failed: {e}")
        sys.exit(0)

    while True:
        time.sleep(INTERVAL_S)
        try:
            for name in refresh():
                print(f"updated {name}", flush=True)
        except Exception as e:  # retried on the next pass
            print(f"refresh failed: {e}", flush=True)
