#!/bin/sh
# Caddy starts fine with an empty upstream and answers 502 behind a passing /health/live, so a missing
# route is refused here instead.
set -eu

if [ -z "${API_UPSTREAM:-}" ]; then
  echo "gateway: API_UPSTREAM (host:port of the api) is required" >&2
  exit 1
fi
# No fallback to the api: it would serve stock from tables the inventory-service no longer writes.
if [ -z "${INVENTORY_UPSTREAM:-}" ]; then
  echo "gateway: INVENTORY_UPSTREAM (host:port of the inventory-service) is required" >&2
  exit 1
fi
# Once /auth has moved off the api, falling back to it would serve auth from tables nobody writes.
if [ "${AUTH_UPSTREAM_REQUIRED:-false}" = "true" ] && [ -z "${AUTH_UPSTREAM:-}" ]; then
  echo "gateway: AUTH_UPSTREAM_REQUIRED is true but AUTH_UPSTREAM is unset" >&2
  exit 1
fi
export AUTH_UPSTREAM="${AUTH_UPSTREAM:-$API_UPSTREAM}"

exec "$@"
