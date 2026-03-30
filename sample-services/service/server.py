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
import urllib.request
import urllib.error

PORT = int(os.environ.get("APP_PORT", "8080"))
SERVICE_NAME = os.environ.get("SERVICE_NAME", "unknown")
# Comma-separated list of downstream services to call, e.g. "service-b.mesh.local:8080"
DOWNSTREAM_TARGETS = os.environ.get("DOWNSTREAM_TARGETS", "")


def _parse_targets():
    if not DOWNSTREAM_TARGETS.strip():
        return {}
    targets = {}
    for entry in DOWNSTREAM_TARGETS.split(","):
        entry = entry.strip()
        host_port = entry.rsplit(":", 1)
        host = host_port[0]
        port = host_port[1] if len(host_port) > 1 else "8080"
        # Derive a short name for the URL path (e.g. "service-b.mesh.local" → "service-b")
        short = host.split(".")[0]
        targets[short] = f"http://{host}:{port}"
    return targets


TARGETS = _parse_targets()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"service": SERVICE_NAME, "status": "healthy"})
        elif self.path == "/":
            self._respond(200, {
                "service": SERVICE_NAME,
                "message": f"Hello from {SERVICE_NAME}!",
                "downstream_targets": list(TARGETS.keys()) or None,
            })
        elif self.path.startswith("/call/"):
            target_name = self.path[len("/call/"):].strip("/")
            self._call_downstream(target_name)
        else:
            self._respond(404, {"error": "not found"})

    def _call_downstream(self, target_name):
        base_url = TARGETS.get(target_name)
        if not base_url:
            self._respond(400, {
                "service": SERVICE_NAME,
                "error": f"Unknown target '{target_name}'. Available: {list(TARGETS.keys())}",
            })
            return
        try:
            req = urllib.request.Request(f"{base_url}/")
            with urllib.request.urlopen(req, timeout=5) as resp:
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
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"{SERVICE_NAME} listening on port {PORT}")
    server.serve_forever()
