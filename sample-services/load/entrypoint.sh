#!/bin/sh
# A Fortio load generator: holds $TPS against $LOAD_TARGET until the task is
# stopped, printing one JSON line of results per 30-second window.
#
# A load test can run many of these tasks, each holding its share of the
# test's TPS, so every window ends on a wall-clock :00 or :30. That way the
# tasks report the same windows, and the service API can add them up.
set -eu

# Fortio's own server answers the mesh's standard health check. Only its
# HTTP echo listener runs; its UI, which can launch load runs against any
# URL, stays off.
fortio server -http-port "${APP_PORT:-8080}" -ui-path= \
  -grpc-port disabled -redirect-port disabled -tcp-port disabled -udp-port disabled \
  >/dev/null 2>&1 &

url="http://${LOAD_TARGET}.${MESH_DOMAIN}:${TARGET_PORT}${LOAD_PATH}?delay=${DELAY_MS}ms&size=${RESPONSE_BYTES}"

# Each connection carries one request at a time, so holding TPS needs
# TPS x latency of them in flight (Little's law). Double it for headroom,
# capped at 1,000: the service API splits a test across enough tasks that
# none needs more (see _load_plan in service-api/handler.py).
# awk, not $(( )): a task's share of a test's TPS can be fractional.
c=$(awk "BEGIN { print int($TPS * ($DELAY_MS + 20) * 2 / 1000) }")
connections=$(( c < 8 ? 8 : (c > 1000 ? 1000 : c) ))

# -uniform staggers the connections' start times; without it they all fire
# together each cycle, and the bursts queue at Envoy and the server (at 1000
# TPS they add ~10ms to p50 that no real client would see).
# -allow-initial-errors keeps a run going when its first requests fail, so a
# failing target shows up as errors rather than as no results at all.
while true; do
  rm -f /tmp/window.json
  # Run to the next :00 or :30. A window of under 5 s would be mostly
  # warm-up, so that one runs on to the boundary after.
  left=$(( 30 - $(date +%s) % 30 ))
  [ "$left" -lt 5 ] && left=$(( left + 30 ))
  fortio load -quiet -uniform -allow-initial-errors -qps "$TPS" -c "$connections" -t "${left}s" \
    -payload-size "$REQUEST_BYTES" -json /tmp/window.json "$url" >/dev/null 2>&1 || true
  # Buckets, not just percentiles: percentiles can't be combined across
  # tasks, but histograms can be summed and percentiles taken from the sum.
  jq -c '{StartTime, ActualDuration, ActualQPS, RetCodes,
          Count: .DurationHistogram.Count,
          Percentiles: .DurationHistogram.Percentiles,
          Buckets: [.DurationHistogram.Data[] | [.Start, .End, .Count]]}' /tmp/window.json 2>/dev/null || true
done
