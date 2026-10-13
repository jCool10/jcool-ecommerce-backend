#!/bin/sh
# Schema, server, namespace and search attributes in one container. Every step is safe to repeat,
# because a restart runs the whole script again.
set -eu

NAMESPACE="${TEMPORAL_NAMESPACE:-jcool}"
RETENTION="${TEMPORAL_NAMESPACE_RETENTION:-7d}"
SCHEMA_DIR=/etc/temporal/schema/postgresql/v12

# A wildcard bind is reachable through loopback; a specific one only through itself. The server
# refuses a wildcard bind without an address to advertise, and the upstream entrypoint fills one in
# for 0.0.0.0 but not for `::`. One node only ever talks to itself, so loopback serves.
case "${BIND_ON_IP:-}" in
  ""|0.0.0.0|::|::0)
    HOST=127.0.0.1
    export TEMPORAL_BROADCAST_ADDRESS="${TEMPORAL_BROADCAST_ADDRESS:-127.0.0.1}"
    ;;
  *:*) HOST="[$BIND_ON_IP]" ;;
  *) HOST="$BIND_ON_IP" ;;
esac
ADDRESS="$HOST:7233"

sql_tool() {
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$DB_PORT" "$@"
}

# The tool exits non-zero when the target already exists; any other failure is real.
tolerate_existing() {
  if out=$("$@" 2>&1); then
    echo "$out"
    return 0
  fi
  case "$out" in
    *"already exists"*) echo "$out"; return 0 ;;
  esac
  echo "$out" >&2
  return 1
}

setup_database() {
  db="$1"
  dir="$2"
  tolerate_existing sql_tool --db "$db" create-database
  tolerate_existing sql_tool --db "$db" setup-schema -v 0.0
  sql_tool --db "$db" update-schema -d "$SCHEMA_DIR/$dir/versioned"
}

setup_database "${DBNAME:-temporal}" temporal
setup_database "${VISIBILITY_DBNAME:-temporal_visibility}" visibility

/etc/temporal/entrypoint.sh &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null || true' TERM INT

tries=0
until temporal operator cluster health --address "$ADDRESS" >/dev/null 2>&1; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "temporal server exited during startup" >&2
    exit 1
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ]; then
    echo "temporal server not healthy after 120s" >&2
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

if temporal operator namespace describe --address "$ADDRESS" --namespace "$NAMESPACE" >/dev/null 2>&1; then
  temporal operator namespace update --address "$ADDRESS" --namespace "$NAMESPACE" --retention "$RETENTION"
else
  temporal operator namespace create --address "$ADDRESS" --namespace "$NAMESPACE" --retention "$RETENTION"
fi

# A new namespace reaches the frontend's cache some seconds after it is registered; until then every
# search-attribute call answers "not found".
tries=0
until temporal operator search-attribute list --address "$ADDRESS" --namespace "$NAMESPACE" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "namespace $NAMESPACE not usable after 60s" >&2
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

ensure_search_attribute() {
  name="$1"
  type="$2"
  if temporal operator search-attribute list --address "$ADDRESS" --namespace "$NAMESPACE" | grep -q "^ *$name "; then
    return 0
  fi
  temporal operator search-attribute create --address "$ADDRESS" --namespace "$NAMESPACE" --name "$name" --type "$type"
}

ensure_search_attribute CheckoutStep Keyword
ensure_search_attribute CheckoutDeadlineAt Datetime

# A forwarded signal makes the first wait return early while the server is still draining.
status=0
wait "$SERVER_PID" || status=$?
if kill -0 "$SERVER_PID" 2>/dev/null; then
  wait "$SERVER_PID" || status=$?
fi
exit "$status"
