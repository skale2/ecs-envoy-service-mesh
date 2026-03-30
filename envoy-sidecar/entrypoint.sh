#!/bin/bash
set -euo pipefail

# =============================================================================
# Envoy Sidecar / Edge Proxy Entrypoint
#
# This script bootstraps the Envoy proxy by:
#   1. Setting up iptables rules (sidecar mode only)
#   2. Fetching xDS configuration files from S3
#   3. Generating a bootstrap envoy.yaml for filesystem-based xDS
#   4. Starting a background config refresh loop
#   5. Launching Envoy
#
# Environment Variables:
#   S3_BUCKET       - S3 bucket containing xDS config files
#   SERVICE_NAME    - Name of this service (used for node identity and S3 path)
#   SIDECAR         - "1" for sidecar mode, "0" for edge proxy mode
#   APP_PORT        - Application port (default: 8080)
#   ENVOY_LOG_LEVEL - Envoy log level (default: info)
#   AWS_REGION      - AWS region for S3 access
# =============================================================================

# --- Default values ---
APP_PORT="${APP_PORT:-8080}"
ENVOY_LOG_LEVEL="${ENVOY_LOG_LEVEL:-info}"
SIDECAR="${SIDECAR:-1}"
CONFIG_DIR="/etc/envoy"
ENVOY_PORT=15000
ENVOY_UID=101

echo "=== Envoy Entrypoint ==="
echo "SERVICE_NAME: ${SERVICE_NAME}"
echo "SIDECAR mode: ${SIDECAR}"
echo "S3_BUCKET: ${S3_BUCKET}"
echo "AWS_REGION: ${AWS_REGION}"

# =============================================================================
# iptables Egress Interception (sidecar mode only)
#
# This is the core of transparent mesh routing. The chain of events:
#   1. App calls service-b.mesh.local:8080
#   2. DNS resolves to the NLB IP (via the Route 53 alias record)
#   3. App initiates a TCP connection to that IP on port 8080
#   4. The iptables OUTPUT chain catches the outgoing SYN packet
#   5. The ENVOY_EGRESS chain redirects it to 127.0.0.1:15000
#   6. Envoy receives the connection, inspects the Host header
#   7. Envoy routes to the real service-b task IP (from xDS config)
#
# The app never knows it is talking to Envoy -- the interception is
# completely transparent at the network level.
# =============================================================================
if [ "${SIDECAR}" = "1" ]; then
    echo "Setting up iptables for egress interception..."

    sudo iptables -t nat -N ENVOY_EGRESS

    # Skip packets originating from Envoy itself (UID 101).
    # Without this rule, Envoy's own outbound connections (to upstream
    # services) would be redirected back to Envoy, creating an infinite loop.
    sudo iptables -t nat -A ENVOY_EGRESS \
      -m owner --uid-owner ${ENVOY_UID} \
      -j RETURN

    # Skip link-local addresses (169.254.0.0/16).
    # ECS uses these for critical infrastructure endpoints:
    #   - 169.254.170.2: task IAM credential endpoint (used by AWS CLI/SDK)
    #   - 169.254.170.4: ECS task metadata endpoint
    #   - 169.254.169.254: EC2 instance metadata (IMDS)
    # Without this exclusion, the AWS CLI inside the container (used by
    # the refresh loop) and the SSM agent (used by ECS Exec) would break.
    sudo iptables -t nat -A ENVOY_EGRESS -d 169.254.0.0/16 \
      -j RETURN

    # Skip HTTPS (443) — AWS API calls (SSM, S3) go through VPC
    # endpoints or NAT gateway; they must not be intercepted by Envoy.
    sudo iptables -t nat -A ENVOY_EGRESS -p tcp --dport 443 \
      -j RETURN

    # Redirect all remaining TCP traffic to Envoy's listener port.
    sudo iptables -t nat -A ENVOY_EGRESS -p tcp \
      -j REDIRECT --to ${ENVOY_PORT}

    # Apply the ENVOY_EGRESS chain to all outbound packets headed to
    # non-local destinations (i.e., not 127.0.0.0/8).
    sudo iptables -t nat -A OUTPUT -p tcp \
      -m addrtype ! --dst-type LOCAL \
      -j ENVOY_EGRESS

    echo "iptables rules configured."
    sudo iptables -t nat -L -n -v
fi

# =============================================================================
# Helper: download an S3 object to a local path using atomic mv.
#
# Envoy's filesystem xDS watches for file *moves* (not writes) to detect
# config changes. By downloading to a temp file and mv'ing into place,
# we trigger an atomic inode change that Envoy's inotify watch detects.
# =============================================================================
s3_download() {
    local s3_uri="$1"
    local dest="$2"
    local tmp="${dest}.tmp"
    aws s3 cp "${s3_uri}" "${tmp}" --region "${AWS_REGION}" && mv -f "${tmp}" "${dest}"
}

# --- Determine S3 prefix based on mode ---
if [ "${SIDECAR}" = "1" ]; then
    S3_PREFIX="services/${SERVICE_NAME}"
else
    S3_PREFIX="edge-proxy"
fi

# --- Fetch xDS configs from S3 with retry logic ---
fetch_configs() {
    s3_download "s3://${S3_BUCKET}/${S3_PREFIX}/cds.yaml" "${CONFIG_DIR}/cds.yaml" && \
    s3_download "s3://${S3_BUCKET}/${S3_PREFIX}/eds.yaml" "${CONFIG_DIR}/eds.yaml" && \
    s3_download "s3://${S3_BUCKET}/${S3_PREFIX}/lds.yaml" "${CONFIG_DIR}/lds.yaml" && \
    s3_download "s3://${S3_BUCKET}/${S3_PREFIX}/rds.yaml" "${CONFIG_DIR}/rds.yaml"
}

echo "Waiting for xDS configs to be available in S3..."
MAX_RETRIES=12
RETRY_INTERVAL=5
RETRY_COUNT=0

while [ ${RETRY_COUNT} -lt ${MAX_RETRIES} ]; do
    if fetch_configs; then
        echo "Successfully fetched xDS configs from S3."
        break
    fi

    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Attempt ${RETRY_COUNT}/${MAX_RETRIES} failed. Retrying in ${RETRY_INTERVAL}s..."
    sleep ${RETRY_INTERVAL}
done

if [ ${RETRY_COUNT} -ge ${MAX_RETRIES} ]; then
    echo "WARNING: Could not fetch xDS configs from S3 after ${MAX_RETRIES} attempts."
    echo "Starting with empty stub configs. The refresh loop will pick up real configs once available."

    for file in cds.yaml eds.yaml lds.yaml rds.yaml; do
        if [ ! -f "${CONFIG_DIR}/${file}" ]; then
            echo "version_info: '0'" > "${CONFIG_DIR}/${file}"
            echo "resources: []" >> "${CONFIG_DIR}/${file}"
        fi
    done
fi

# =============================================================================
# Bootstrap envoy.yaml (filesystem-based xDS)
#
# Instead of connecting to a gRPC control plane, Envoy reads CDS and LDS
# from local YAML files via path_config_source.  Envoy watches each file
# path for atomic moves (mv); when the background refresh loop below
# replaces a file, Envoy detects the inode change and hot-reloads.
#
# EDS and RDS are loaded indirectly: CDS clusters reference an EDS file,
# and LDS listeners reference an RDS file, both via path_config_source.
# =============================================================================
echo "Generating Envoy bootstrap configuration..."
cat > "${CONFIG_DIR}/envoy.yaml" <<EOF
node:
  id: ${SERVICE_NAME}-${HOSTNAME}
  cluster: ${SERVICE_NAME}

dynamic_resources:
  cds_config:
    path_config_source:
      path: /etc/envoy/cds.yaml
  lds_config:
    path_config_source:
      path: /etc/envoy/lds.yaml

admin:
  address:
    socket_address:
      address: 0.0.0.0
      port_value: 9901

# Pipe Envoy metrics to the cw-agent sidecar via DogStatsD (UDP 8126).
# The cw-agent forwards them to CloudWatch under the /ecs/envoy-mesh/StatsD namespace.
stats_sinks:
  - name: envoy.stat_sinks.dog_statsd
    typed_config:
      "@type": type.googleapis.com/envoy.config.metrics.v3.DogStatsdSink
      address:
        socket_address:
          address: 127.0.0.1
          port_value: 8126
          protocol: UDP

# Append service name as a dimension to all metrics in CloudWatch
stats_config:
  stats_tags:
    - tag_name: mesh.service
      fixed_value: ${SERVICE_NAME}
EOF

echo "Bootstrap config written to ${CONFIG_DIR}/envoy.yaml"

# =============================================================================
# Background Config Refresh Loop (eTag-based)
#
# Polls S3 every 5 seconds for updated xDS configs. Uses S3 eTags to avoid
# unnecessary downloads and disk writes. Only when the eTag changes (meaning
# the Lambda uploaded new content) do we download and mv the file, which
# triggers Envoy's inotify-based hot-reload.
# =============================================================================
ETAG_DIR="/tmp/etags"
mkdir -p "${ETAG_DIR}"

refresh_one_file() {
    local s3_key="$1"
    local local_path="$2"
    local etag_file="${ETAG_DIR}/$(echo "${s3_key}" | tr '/' '_')"

    # Fetch the current eTag from S3 without downloading the file body.
    local new_etag
    new_etag=$(aws s3api head-object --bucket "${S3_BUCKET}" --key "${s3_key}" --region "${AWS_REGION}" --query ETag --output text 2>/dev/null) || return 0

    local old_etag=""
    [ -f "${etag_file}" ] && old_etag=$(cat "${etag_file}")

    # Only download + mv if the eTag changed (content was updated in S3).
    if [ "${new_etag}" != "${old_etag}" ]; then
        s3_download "s3://${S3_BUCKET}/${s3_key}" "${local_path}" && \
            echo "${new_etag}" > "${etag_file}"
    fi
}

refresh_configs_loop() {
    while true; do
        sleep 5
        for file in cds.yaml eds.yaml lds.yaml rds.yaml; do
            refresh_one_file "${S3_PREFIX}/${file}" "${CONFIG_DIR}/${file}"
        done
    done
}

echo "Starting background config refresh loop (every 5s, eTag-based)..."
refresh_configs_loop &

# --- Launch Envoy ---
echo "Starting Envoy proxy..."
exec envoy \
    -c "${CONFIG_DIR}/envoy.yaml" \
    --service-cluster "${SERVICE_NAME}" \
    --service-node "${SERVICE_NAME}-${HOSTNAME}" \
    --log-level "${ENVOY_LOG_LEVEL}"
