#!/bin/bash
# Starts Envoy as a sidecar (SIDECAR=1) or as the edge proxy (SIDECAR=0):
#
#   1. sidecar only: iptables hands Envoy every outbound connection
#   2. fetch the mesh's config from S3
#   3. write a bootstrap that points Envoy at those files
#   4. keep the files current in the background, and start Envoy
#
# Environment: SERVICE_NAME, S3_BUCKET, AWS_REGION, and optionally SIDECAR
# (default 1), APP_PORT (8080), ENVOY_LOG_LEVEL (info), ENVOY_CONCURRENCY.
set -euo pipefail

SIDECAR="${SIDECAR:-1}"
ENVOY_LOG_LEVEL="${ENVOY_LOG_LEVEL:-info}"
CONFIG_DIR="/etc/envoy"
ENVOY_PORT=15000
ENVOY_UID=101

echo "Starting Envoy for ${SERVICE_NAME} (sidecar=${SIDECAR}), config from s3://${S3_BUCKET}/mesh/"

# =============================================================================
# 1. Interception
#
# The app calls predict.demo.mesh:8080. DNS answers with the edge NLB's
# address, and the app connects to it; iptables catches that connection on
# its way out and hands it to Envoy on :15000 instead. Envoy reads the Host
# header and sends the request straight to one of predict's tasks. The app
# never knows: the containers in a task share one network namespace, so these
# rules apply to its traffic too.
# =============================================================================
if [ "${SIDECAR}" = "1" ]; then
    sudo iptables -t nat -N ENVOY_EGRESS
    # Envoy's own traffic, or every upstream call would loop back into Envoy.
    sudo iptables -t nat -A ENVOY_EGRESS -m owner --uid-owner ${ENVOY_UID} -j RETURN
    # Link-local: the task's credentials and metadata (169.254.170.2, .4) and
    # the instance's (169.254.169.254) live here.
    sudo iptables -t nat -A ENVOY_EGRESS -d 169.254.0.0/16 -j RETURN
    # HTTPS, so calls to AWS APIs go straight out.
    sudo iptables -t nat -A ENVOY_EGRESS -p tcp --dport 443 -j RETURN
    # Everything else goes to Envoy's listener.
    sudo iptables -t nat -A ENVOY_EGRESS -p tcp -j REDIRECT --to ${ENVOY_PORT}
    # For every outbound connection that isn't to this task itself.
    sudo iptables -t nat -A OUTPUT -p tcp -m addrtype ! --dst-type LOCAL -j ENVOY_EGRESS
    sudo iptables -t nat -L ENVOY_EGRESS -n
fi

# =============================================================================
# 2. Config
#
# The same four files for every proxy in the mesh; see refresh.py. S3 can be
# briefly behind a new mesh, so this retries for a minute, then starts on
# empty config for the refresh loop to fill in.
# =============================================================================
for attempt in $(seq 1 12); do
    python3 /usr/local/bin/refresh.py --once && break
    echo "Config fetch ${attempt}/12 failed; retrying in 5s"
    sleep 5
done
for file in cds.yaml eds.yaml lds.yaml rds.yaml; do
    [ -f "${CONFIG_DIR}/${file}" ] || echo 'resources: []' > "${CONFIG_DIR}/${file}"
done
# The local cluster below reads this service's own endpoints file, which has
# to exist when Envoy starts. A load generator or the edge proxy has none.
OWN_ENDPOINTS="${CONFIG_DIR}/eds/${SERVICE_NAME}.yaml"
[ -f "${OWN_ENDPOINTS}" ] || echo 'resources: []' > "${OWN_ENDPOINTS}"

# Zone-aware routing needs this task's zone, from ECS's task metadata. Off ECS
# it is empty, and Envoy spreads requests across zones evenly.
ZONE=$(curl -fsS --max-time 2 "${ECS_CONTAINER_METADATA_URI_V4:-}/task" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["AvailabilityZone"])' 2>/dev/null) || ZONE=""

# =============================================================================
# 3. Bootstrap
#
# No control-plane address: Envoy reads its clusters and listener from files,
# and reloads one when a new version is moved into place. The listener in
# lds.yaml points at rds.yaml the same way, and each cluster in cds.yaml at
# its endpoints file under eds/.
# =============================================================================
cat > "${CONFIG_DIR}/envoy.yaml" <<EOF
node:
  id: ${SERVICE_NAME}-${HOSTNAME}
  cluster: ${SERVICE_NAME}
  locality:
    region: "${AWS_REGION}"
    zone: "${ZONE}"

dynamic_resources:
  cds_config:
    path_config_source:
      path: ${CONFIG_DIR}/cds.yaml
  lds_config:
    path_config_source:
      path: ${CONFIG_DIR}/lds.yaml

# Zone-aware routing compares how an upstream's tasks are spread across zones
# with how this service's own are. Envoy takes the latter from a "local
# cluster", which has to be defined here: this service's endpoints, from the
# same file its callers read.
cluster_manager:
  local_cluster_name: local
static_resources:
  clusters:
  - name: local
    type: EDS
    connect_timeout: 0.25s
    eds_cluster_config:
      service_name: ${SERVICE_NAME}
      eds_config:
        path_config_source:
          path: ${OWN_ENDPOINTS}
  - name: envoy_admin
    type: STATIC
    connect_timeout: 0.25s
    load_assignment:
      cluster_name: envoy_admin
      endpoints: [{lb_endpoints: [{endpoint: {address: {socket_address: {address: 127.0.0.1, port_value: 9902}}}}]}]

  # Envoy's admin interface can reconfigure and stop it, and has no
  # authentication, so it listens on loopback only. The rest of the VPC (the
  # graph Lambda, the edge NLB's health check) gets a read-only view of it on
  # :9901: GET /ready, /stats and /clusters, and nothing else.
  listeners:
  - name: admin_readonly
    address: {socket_address: {address: 0.0.0.0, port_value: 9901}}
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: admin_readonly
          route_config:
            virtual_hosts:
            - name: admin_readonly
              domains: ["*"]
              routes:
              - match: {path: /ready, headers: [{name: ":method", string_match: {exact: GET}}]}
                route: {cluster: envoy_admin}
              - match: {path: /stats, headers: [{name: ":method", string_match: {exact: GET}}]}
                route: {cluster: envoy_admin}
              - match: {path: /clusters, headers: [{name: ":method", string_match: {exact: GET}}]}
                route: {cluster: envoy_admin}
              - match: {prefix: /}
                direct_response: {status: 403}
          http_filters:
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

admin:
  address:
    socket_address:
      address: 127.0.0.1
      port_value: 9902

# Metrics go to the CloudWatch agent sidecar over DogStatsD, tagged with the
# service they came from.
stats_sinks:
- name: envoy.stat_sinks.dog_statsd
  typed_config:
    "@type": type.googleapis.com/envoy.config.metrics.v3.DogStatsdSink
    address:
      socket_address:
        address: 127.0.0.1
        port_value: 8126
        protocol: UDP
stats_config:
  stats_tags:
  - tag_name: mesh.service
    fixed_value: ${SERVICE_NAME}
EOF

# =============================================================================
# 4. Run
# =============================================================================
python3 /usr/local/bin/refresh.py &

# Envoy runs a worker per host CPU unless ENVOY_CONCURRENCY says otherwise.
if [ -n "${ENVOY_CONCURRENCY:-}" ]; then set -- --concurrency "${ENVOY_CONCURRENCY}"; else set --; fi
exec envoy -c "${CONFIG_DIR}/envoy.yaml" --log-level "${ENVOY_LOG_LEVEL}" "$@"
