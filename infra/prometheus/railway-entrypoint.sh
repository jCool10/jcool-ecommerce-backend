#!/bin/sh
# Railway has no bind mounts and no file-backed secrets: the scrape token arrives as an env var and
# the api's address is only resolvable at runtime. Both are materialised here, before Prometheus
# reads its config.
set -eu

: "${METRICS_TOKEN:?METRICS_TOKEN is required — /metrics answers 404 without it}"
: "${API_TARGET:?API_TARGET is required}"

mkdir -p /etc/prometheus/secrets
printf '%s' "$METRICS_TOKEN" > /etc/prometheus/secrets/metrics-token
chmod 600 /etc/prometheus/secrets/metrics-token

sed "s|__API_TARGET__|${API_TARGET}|g" \
  /etc/prometheus/prometheus.railway.yml > /etc/prometheus/prometheus.yml

# Railway's private network is IPv6-only: bound to 0.0.0.0 (the default), Grafana could not reach it.
exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time=15d \
  --web.listen-address='[::]:9090'
