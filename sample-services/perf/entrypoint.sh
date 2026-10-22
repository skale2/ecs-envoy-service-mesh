#!/bin/sh
# Fortio in one of two roles, chosen by LOAD_TARGET.
#
# Unset: a perf target. An echo server that honours ?delay= and ?size= on
#   every request, so a load test sets server latency and response size per
#   request and the target never needs reconfiguring.
#
# Set: a load generator. Holds $TPS against $LOAD_TARGET until the task is
#   stopped, printing one JSON line per 30-second window.
set -eu

# Only the HTTP echo listener; Fortio's UI, which can launch load runs
# against any URL, stays off.
server_args="-http-port ${APP_PORT:-8080} -ui-path= -max-echo-delay 10s
  -grpc-port disabled -redirect-port disabled -tcp-port disabled -udp-port disabled"

if [ -z "${LOAD_TARGET:-}" ]; then
  exec fortio server $server_args
fi

# The load generator answers the standard health check too.
fortio server $server_args >/dev/null 2>&1 &

url="http://${LOAD_TARGET}.${MESH_DOMAIN}:${TARGET_PORT}${LOAD_PATH}?delay=${DELAY_MS}ms&size=${RESPONSE_BYTES}"

# Each connection carries one request at a time, so holding TPS needs
# TPS x latency of them in flight (Little's law). Double it for headroom,
# keeping under Envoy's default limit of 1024 connections per upstream.
c=$(( TPS * (DELAY_MS + 20) * 2 / 1000 ))
connections=$(( c < 8 ? 8 : (c > 1000 ? 1000 : c) ))

# -uniform staggers the connections' start times; without it they all fire
# together each cycle, and the bursts queue at Envoy and the server (at 1000
# TPS they add ~10ms to p50 that no real client would see).
# -allow-initial-errors keeps a run going when its first requests fail, so a
# failing target shows up as errors rather than as no results at all.
while true; do
  rm -f /tmp/window.json
  fortio load -quiet -uniform -allow-initial-errors -qps "$TPS" -c "$connections" -t 30s \
    -payload-size "$REQUEST_BYTES" -json /tmp/window.json "$url" >/dev/null 2>&1 || true
  jq -c '{StartTime, ActualQPS, RetCodes,
          Count: .DurationHistogram.Count,
          Percentiles: .DurationHistogram.Percentiles}' /tmp/window.json 2>/dev/null || true
done
