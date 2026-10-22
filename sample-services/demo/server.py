"""Generic demo service for the Envoy service mesh.

This is a single Python file that can become *any* service in the mesh —
its identity (name, port, downstream targets) is configured entirely via
environment variables set in the ECS task definition. This keeps the demo
simple: one Docker image, many services.

Key mesh interaction:
  GET /call/{target} makes an HTTP request to http://{target}.mesh.local/
  through the mesh. The application has NO awareness of Envoy — it simply
  opens a connection to a .mesh.local hostname. Transparently, iptables
  REDIRECT rules in the task's network namespace intercept that outbound
  connection and send it to the local Envoy sidecar (port 15000). Envoy
  then resolves the Host header to the correct upstream cluster and
  forwards the request to a healthy backend.
"""

import http.server
import json
import os
import urllib.error
import urllib.parse
import urllib.request

PORT = int(os.environ.get("APP_PORT", "8080"))
SERVICE_NAME = os.environ.get("SERVICE_NAME", "unknown")
# The mesh is fully connected, so there is no list of downstream services to
# configure. Any service is reachable at {name}.{MESH_DOMAIN} — that
# convention is the whole addressing scheme.
MESH_DOMAIN = os.environ.get("MESH_DOMAIN", "demo.mesh")
DEFAULT_TARGET_PORT = os.environ.get("DEFAULT_TARGET_PORT", "8080")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path  # route on the path, not the query
        if path == "/health":
            self._respond(200, {"service": SERVICE_NAME, "status": "healthy"})
        elif path == "/":
            self._respond(200, {
                "service": SERVICE_NAME,
                "message": f"Hello from {SERVICE_NAME}!",
            })
        elif path.startswith("/call/"):
            target_name = path[len("/call/"):].strip("/")
            self._call_downstream(target_name)
        else:
            self._respond(404, {"error": "not found"})

    def _call_downstream(self, target_name):
        # No lookup table: a mesh service's address is just its name plus the
        # mesh domain. This is the one line that shows what the mesh buys you
        # — the app opens a plain HTTP connection to a hostname and never
        # learns that Envoy, iptables, or task IPs exist.
        base_url = f"http://{target_name}.{MESH_DOMAIN}:{DEFAULT_TARGET_PORT}"
        try:
            req = urllib.request.Request(f"{base_url}/")
            with urllib.request.urlopen(req, timeout=5) as resp:  # nosec B310 - scheme is hardcoded http
                body = json.loads(resp.read().decode())
                self._respond(200, {
                    "service": SERVICE_NAME,
                    "downstream_call": {"target": target_name, "url": base_url, "response": body},
                })
        except urllib.error.URLError as e:
            self._respond(502, {
                "service": SERVICE_NAME,
                "error": f"Failed to call {target_name} at {base_url}: {e}",
            })

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, format, *args):
        print(f"[{SERVICE_NAME}] {args[0]}")


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)  # nosec B104 - ECS container must listen on all interfaces
    print(f"{SERVICE_NAME} listening on port {PORT}")
    server.serve_forever()
