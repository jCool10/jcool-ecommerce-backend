#!/usr/bin/env bash
# Usage: scripts/ephemeral-stack.sh <images.env> <up|seed|smoke|logs <dir>|down>
# The whole compose stack on prebuilt images, as the PR check and the rehearsal on main run it.
# <images.env> has one `<bake target>=<image ref>` line per image: local tags or registry digests.
# Runs as its own compose project with env files built from the committed templates, so the
# containers never see the dev .env files and the dev stack's volumes are never removed.
set -euo pipefail

usage() {
  echo "usage: $0 <images.env> <up|seed|smoke|logs <dir>|down>" >&2
  exit 2
}
[ $# -ge 2 ] || usage
cmd=$2
[ -f "$1" ] || { echo "no such images file: $1" >&2; exit 2; }
images_file=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
if [ "$cmd" = logs ]; then
  [ $# -eq 3 ] || usage
  mkdir -p "$3"
  logs_dir=$(cd "$3" && pwd)
fi

cd "$(dirname "$0")/.."

project=jcool-ci
export JCOOL_CI_ENV_DIR=${EPHEMERAL_STACK_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}/jcool-ci-stack
env_file=$JCOOL_CI_ENV_DIR/root.env

while IFS='=' read -r target ref || [ -n "$target" ]; do
  [ -n "$target" ] || continue
  export "JCOOL_IMAGE_$(tr '[:lower:]-' '[:upper:]_' <<<"$target")=$ref"
done <"$images_file"

compose=(docker compose -p "$project" --env-file "$env_file" -f docker-compose.yml -f docker-compose.ci.yml --profile user-service)

env_value() { # env_value <key> <default>
  local value
  value=$(sed -n "s/^$1=//p" "$env_file" | tail -1)
  echo "${value:-$2}"
}

write_env() {
  local key
  mkdir -p "$JCOOL_CI_ENV_DIR"
  chmod 700 "$JCOOL_CI_ENV_DIR"
  cp .env.example "$env_file"
  cp apps/user-service/.env.example "$JCOOL_CI_ENV_DIR/user-service.env"
  # A signing key that lives as long as the stack, generated the way apps/user-service/.env.example says.
  key=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | awk '{printf "%s\\n", $0}')
  printf '\nJWT_ES256_PRIVATE_KEYS=dev-1:%s\n' "$key" >>"$JCOOL_CI_ENV_DIR/user-service.env"
  chmod 600 "$env_file" "$JCOOL_CI_ENV_DIR/user-service.env"
}

case "$cmd" in
  up)
    # Same container ports on the host: the dev stack has to be stopped, not removed.
    if [ -n "$(docker ps -q --filter label=com.docker.compose.project=jcool-ecommerce)" ]; then
      echo "the dev stack is running and holds the same host ports; stop it with 'docker compose stop' (its volumes stay)" >&2
      exit 1
    fi
    # Leftover volumes would hand this run an old database.
    if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] ||
      [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]; then
      echo "an earlier ephemeral stack is still there; run '$0 $images_file down' first" >&2
      exit 1
    fi
    write_env
    "${compose[@]}" up -d --wait --wait-timeout 600
    ;;
  seed)
    # The catalog seed is a tsx script left out of the api image, so it runs from the host.
    pnpm turbo run build --filter=@jcool/id-codec --filter=@jcool/id-generator
    DATABASE_URL="postgresql://$(env_value POSTGRES_USER jcool):$(env_value POSTGRES_PASSWORD '')@127.0.0.1:$(env_value POSTGRES_HOST_PORT 5433)/$(env_value POSTGRES_DB jcool_ecommerce)?schema=public" \
      pnpm --filter @jcool/api db:seed
    # Lists the catalog through the gateway, so it has to come after the catalog seed.
    "${compose[@]}" exec -T inventory-service node dist/database/seed-stock.js
    ;;
  smoke)
    gateway="http://127.0.0.1:$(env_value GATEWAY_HOST_PORT 8080)"
    curl -fsS -o /dev/null --max-time 10 --retry 30 --retry-delay 2 --retry-all-errors "$gateway/health/ready"
    "${compose[@]}" --profile smoke run --rm -T smoke
    scripts/check-internal-auth.sh "$gateway" "${compose[@]}" exec -T redis redis-cli
    ;;
  logs)
    "${compose[@]}" --profile '*' ps -a >"$logs_dir/ps.txt" || true
    for service in $("${compose[@]}" --profile '*' ps -a --format '{{.Service}}' | sort -u); do
      "${compose[@]}" --profile '*' logs --no-color --timestamps "$service" >"$logs_dir/$service.log" 2>&1 || true
    done
    ;;
  down)
    [ -f "$env_file" ] || write_env
    "${compose[@]}" --profile '*' down -v --remove-orphans
    rm -rf "$JCOOL_CI_ENV_DIR"
    ;;
  *)
    usage
    ;;
esac
