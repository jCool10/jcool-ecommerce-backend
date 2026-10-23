#!/bin/sh
# Brings up what temporalio/server leaves to an operator — databases, schema, namespace, search
# attributes — then stays the server's parent so the platform's SIGTERM reaches it. Every step is
# safe to repeat and has a time limit; a failed step kills the server and exits 1 so the platform
# restarts the container. No `set -x`: the Postgres password is in the environment.
set -eu

: "${DB:?DB must be postgres12}"
: "${DB_PORT:=5432}"
: "${POSTGRES_SEEDS:?}"
: "${POSTGRES_USER:?}"
: "${POSTGRES_PWD:?}"
: "${BIND_ON_IP:?}"
# Fixed for the life of the database: changing it means a new database (RUNBOOK).
: "${NUM_HISTORY_SHARDS:?}"
: "${TEMPORAL_NAMESPACE:=jcool}"
: "${TEMPORAL_NAMESPACE_RETENTION:?}"
export DB DB_PORT

SCHEMA_DIR=/etc/temporal/schema/postgresql/v12
server_pid=
# The last step's output, shown when it fails. The tools never print the password.
output=

log() { echo "temporal-bootstrap: $*"; }

fail() {
  [ -z "$output" ] || printf '%s\n' "$output" | tail -n 20
  log "$*"
  [ -n "$server_pid" ] && kill -TERM "$server_pid" 2>/dev/null
  exit 1
}

# Runs the command every 2s until it succeeds or the limit (seconds) passes; gives up at once if the
# server has exited, since nothing will answer.
retry_for() {
  limit=$1
  shift
  deadline=$(($(date +%s) + limit))
  until output=$("$@" 2>&1); do
    if [ -n "$server_pid" ] && ! kill -0 "$server_pid" 2>/dev/null; then
      output=
      fail "server exited during bootstrap"
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 2
  done
}

sql_tool() {
  SQL_PASSWORD="$POSTGRES_PWD" temporal-sql-tool --plugin "$DB" --ep "$POSTGRES_SEEDS" -p "$DB_PORT" \
    -u "$POSTGRES_USER" "$@"
}

# create is a no-op on an existing database and setup-schema skips a database that already has a
# version, so both run on every boot; update-schema then applies whatever the image adds.
prepare_database() {
  sql_tool --db "$1" create && sql_tool --db "$1" setup-schema -v 0.0 &&
    sql_tool --db "$1" update-schema -d "$SCHEMA_DIR/$2/versioned"
}

retry_for 120 sql_tool --db temporal create || fail "postgres at $POSTGRES_SEEDS:$DB_PORT not reachable"
output=$(prepare_database temporal temporal 2>&1) || fail "schema of temporal failed"
output=$(prepare_database temporal_visibility visibility 2>&1) || fail "schema of temporal_visibility failed"
log "schema ready"

# The upstream entrypoint fills the broadcast address for 0.0.0.0 and ::0 only, and the server
# refuses to start on a wildcard without one (Railway binds ::).
case "$BIND_ON_IP" in
  0.0.0.0 | :: | ::0)
    if [ -z "${TEMPORAL_BROADCAST_ADDRESS:-}" ]; then
      TEMPORAL_BROADCAST_ADDRESS=$(hostname -i | awk '{print $1}')
      export TEMPORAL_BROADCAST_ADDRESS
    fi
    frontend=127.0.0.1:7233
    ;;
  *:*) frontend="[$BIND_ON_IP]:7233" ;;
  *) frontend="$BIND_ON_IP:7233" ;;
esac

/etc/temporal/entrypoint.sh &
server_pid=$!
trap 'kill -TERM "$server_pid" 2>/dev/null || true' TERM INT

cli() { temporal --address "$frontend" "$@"; }
serving() { cli operator cluster health | grep -q SERVING; }
namespace_exists() { cli operator namespace describe --namespace "$TEMPORAL_NAMESPACE"; }
upsert_namespace() {
  if namespace_exists >/dev/null 2>&1; then
    cli operator namespace update --namespace "$TEMPORAL_NAMESPACE" --retention "$TEMPORAL_NAMESPACE_RETENTION"
  else
    cli operator namespace create --namespace "$TEMPORAL_NAMESPACE" --retention "$TEMPORAL_NAMESPACE_RETENTION"
  fi
}
# A namespace created a moment ago is not in the frontend's cache yet, so this is what to wait on
# before creating search attributes.
list_attributes() { cli operator search-attribute list --namespace "$TEMPORAL_NAMESPACE"; }
ensure_attribute() {
  list_attributes | grep -qw "$1" ||
    cli operator search-attribute create --namespace "$TEMPORAL_NAMESPACE" --name "$1" --type "$2"
}

retry_for 120 serving || fail "server not serving on $frontend"
retry_for 60 upsert_namespace || fail "namespace $TEMPORAL_NAMESPACE not created"
retry_for 60 list_attributes || fail "namespace $TEMPORAL_NAMESPACE not visible to the frontend"
retry_for 60 ensure_attribute CheckoutStep Keyword || fail "search attribute CheckoutStep not created"
retry_for 60 ensure_attribute CheckoutDeadlineAt Datetime || fail "search attribute CheckoutDeadlineAt not created"
log "namespace $TEMPORAL_NAMESPACE ready (retention $TEMPORAL_NAMESPACE_RETENTION)"

status=0
wait "$server_pid" || status=$?
# A trapped signal returns from wait while the server is still draining.
while kill -0 "$server_pid" 2>/dev/null; do
  wait "$server_pid" || status=$?
done
exit "$status"
