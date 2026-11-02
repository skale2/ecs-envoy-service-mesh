"""Serves the mesh dashboard at http://127.0.0.1:8000.

    python3 dashboard/serve.py

The page polls /api/graph and /api/load, and fetches /api/load/<target> when
you click a load generator. This forwards those read-only requests to the mesh
API, signed with your local AWS credentials, so no credentials reach the
browser. It listens on loopback only, and forwards nothing else.

Needs botocore (installed with awscurl). The API URL comes from MESH_API if
set, otherwise from the mesh stack's outputs.
"""
import http.server
import os
import pathlib
import re
import urllib.error
import urllib.request

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session

REGION = os.environ.get("MESH_REGION", "us-west-2")
PORT = int(os.environ.get("DASHBOARD_PORT", "8000"))
PAGE = pathlib.Path(__file__).parent / "index.html"
FORWARDED = re.compile(r"^/api(/graph|/load|/load/[a-z][a-z0-9-]{1,30})$")

session = Session()


def _api_url():
    if os.environ.get("MESH_API"):
        return os.environ["MESH_API"].rstrip("/")
    stack = os.environ.get("MESH_STACK", "DemoEnvoyServiceMesh")
    outputs = session.create_client("cloudformation", region_name=REGION) \
        .describe_stacks(StackName=stack)["Stacks"][0]["Outputs"]
    return next(o["OutputValue"] for o in outputs if "ServiceApiEndpoint" in o["OutputKey"]).rstrip("/")


API_URL = _api_url()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        forwarded = FORWARDED.match(self.path)
        if self.path == "/":
            self._send(200, "text/html; charset=utf-8", PAGE.read_bytes())  # edits show on refresh
        elif forwarded:
            url = API_URL + forwarded[1]
            # Fresh credentials each time: tools like ada rotate them on disk,
            # and a session would keep signing with the expired ones.
            request = AWSRequest(method="GET", url=url)
            SigV4Auth(Session().get_credentials(), "execute-api", REGION).add_auth(request)
            try:
                with urllib.request.urlopen(
                        urllib.request.Request(url, headers=dict(request.headers)), timeout=10) as r:
                    self._send(200, "application/json", r.read())
            except urllib.error.HTTPError as e:
                self._send(e.code, "application/json", e.read())
        else:
            self._send(404, "text/plain", b"not found")

    def _send(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"mesh dashboard: http://127.0.0.1:{PORT}  (API {API_URL})", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
