#!/usr/bin/env bash
#
# Out-of-band sampler for the four metric families the app's /metrics scrape does NOT carry.
# The app exposes RED (http_request_*), cache (catalog_cache_operations_total,
# cache_rebuild_duration_seconds) and Node runtime (eventloop lag, GC, heap) — nothing about the
# pg connection pool, the server-side session states, Redis, or per-container CPU. Prometheus
# therefore cannot answer "was the pool exhausted", "was anything idle-in-transaction", "did the
# cache actually hit", or "which container burned the CPU", and those are exactly the questions
# that turn a latency number into an attributed bottleneck.
#
# Run this CONCURRENTLY with k6, for the same wall-clock window. Prometheus stays authoritative
# for latency/error rate; this file is the correlate, joined on the `ts` epoch seconds.
#
# Usage:
#   scripts/capture-perf-run.sh <label> <duration-sec> [interval-sec] [out-dir]
#
# Emits, under <out-dir>/<label>/:
#   samples.jsonl  — one JSON object per tick
#   pgss.tsv       — pg_stat_statements top 25 by total_exec_time, for the run window only
#   tables.tsv     — per-table seq_scan / idx_scan / n_tup_* for the run window only
#   meta.json      — what was sampled, and the knobs that were in force
#
# Statistics are RESET at start (pg_stat_statements_reset + pg_stat_reset), so both dumps cover
# the run window and nothing else. That is destructive to cumulative stats — this is a load-test
# database, and the counters are derived, not data.
set -euo pipefail

LABEL=${1:?usage: capture-perf-run.sh <label> <duration-sec> [interval-sec] [out-dir]}
DURATION=${2:?usage: capture-perf-run.sh <label> <duration-sec> [interval-sec] [out-dir]}
INTERVAL=${3:-5}
OUT_ROOT=${4:-plans/260911-0904-k6-performance-program/results}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# Credentials come from .env the same way docker-compose reads them. Never echoed.
PGU=$(awk -F= '/^POSTGRES_USER=/{sub(/^POSTGRES_USER=/,"");print;exit}' .env)
PGD=$(awk -F= '/^POSTGRES_DB=/{sub(/^POSTGRES_DB=/,"");print;exit}' .env)
: "${PG_CONTAINER:=jcool-postgres}"
: "${REDIS_CONTAINER:=jcool-redis}"
: "${APP_CONTAINER:=jcool-app}"

OUT="$OUT_ROOT/$LABEL"
mkdir -p "$OUT"

psql_q() { docker exec "$PG_CONTAINER" psql -U "$PGU" -d "$PGD" -qtAF$'\t' -c "$1"; }

# pool.max is the app's own ceiling (DB_POOL_MAX, default 10 in src/shared/config/configuration.ts).
# Utilization below is server-side backends / this, which is the only view available without an
# app-side gauge: the pool never opens more sessions than it holds.
POOL_MAX=${DB_POOL_MAX:-10}

echo "[capture] $LABEL — ${DURATION}s @ ${INTERVAL}s → $OUT"

# Window starts clean so pgss.tsv and tables.tsv describe this run and no earlier one.
psql_q "select pg_stat_statements_reset() is not null" >/dev/null
psql_q "select pg_stat_reset() is null" >/dev/null

START=$(date +%s)
END=$((START + DURATION))

: > "$OUT/samples.jsonl"

while [ "$(date +%s)" -lt "$END" ]; do
  TS=$(date +%s)

  # One round-trip for every session-state counter. `client backend` excludes the autovacuum and
  # background workers, which are not the app and would inflate the pool reading.
  read -r act idle iit iita lockwait maxxact total <<<"$(psql_q "
    select
      count(*) filter (where state = 'active'),
      count(*) filter (where state = 'idle'),
      count(*) filter (where state = 'idle in transaction'),
      count(*) filter (where state = 'idle in transaction (aborted)'),
      count(*) filter (where wait_event_type = 'Lock'),
      coalesce(round(max(extract(epoch from now() - xact_start))::numeric, 3), 0),
      count(*)
    from pg_stat_activity
    where datname = current_database() and backend_type = 'client backend';" | tr '\t' ' ')"

  # keyspace_hits/misses are cumulative since the server started — the per-window hit rate is the
  # DELTA between the first and last sample, not the value here.
  R=$(docker exec "$REDIS_CONTAINER" redis-cli info stats 2>/dev/null | tr -d '\r')
  rops=$(printf '%s\n' "$R" | awk -F: '/^instantaneous_ops_per_sec:/{print $2}')
  rhit=$(printf '%s\n' "$R" | awk -F: '/^keyspace_hits:/{print $2}')
  rmiss=$(printf '%s\n' "$R" | awk -F: '/^keyspace_misses:/{print $2}')
  rconn=$(docker exec "$REDIS_CONTAINER" redis-cli info clients 2>/dev/null | tr -d '\r' \
    | awk -F: '/^connected_clients:/{print $2}')

  # One docker call for all three containers; --no-stream so the tick has a bounded cost.
  STATS=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemPerc}}' \
    "$APP_CONTAINER" "$PG_CONTAINER" "$REDIS_CONTAINER" 2>/dev/null | tr -d '%')
  app_cpu=$(printf '%s\n' "$STATS" | awk -v n="$APP_CONTAINER" '$1==n{print $2}')
  pg_cpu=$(printf '%s\n' "$STATS" | awk -v n="$PG_CONTAINER" '$1==n{print $2}')
  rd_cpu=$(printf '%s\n' "$STATS" | awk -v n="$REDIS_CONTAINER" '$1==n{print $2}')
  app_mem=$(printf '%s\n' "$STATS" | awk -v n="$APP_CONTAINER" '$1==n{print $3}')
  pg_mem=$(printf '%s\n' "$STATS" | awk -v n="$PG_CONTAINER" '$1==n{print $3}')

  printf '{"ts":%s,"t":%s,"pg":{"active":%s,"idle":%s,"idle_in_txn":%s,"idle_in_txn_aborted":%s,"lock_wait":%s,"max_xact_sec":%s,"backends":%s,"pool_max":%s,"pool_util":%s},"redis":{"ops":%s,"hits":%s,"misses":%s,"clients":%s},"cpu":{"app":%s,"postgres":%s,"redis":%s},"mem":{"app":%s,"postgres":%s}}\n' \
    "$TS" "$((TS - START))" \
    "${act:-0}" "${idle:-0}" "${iit:-0}" "${iita:-0}" "${lockwait:-0}" "${maxxact:-0}" \
    "${total:-0}" "$POOL_MAX" \
    "$(awk -v b="${total:-0}" -v m="$POOL_MAX" 'BEGIN{printf "%.3f", (m>0? b/m : 0)}')" \
    "${rops:-0}" "${rhit:-0}" "${rmiss:-0}" "${rconn:-0}" \
    "${app_cpu:-0}" "${pg_cpu:-0}" "${rd_cpu:-0}" \
    "${app_mem:-0}" "${pg_mem:-0}" \
    >> "$OUT/samples.jsonl"

  # Sleep only the remainder, so a slow tick does not drift the series.
  NEXT=$((TS + INTERVAL))
  NOW=$(date +%s)
  [ "$NEXT" -gt "$NOW" ] && sleep $((NEXT - NOW)) || true
done

# Evidence dumps for the bottleneck pass. total_exec_time is the ranking that matters: a fast query
# run a million times outranks a slow one run twice, and only this ordering finds it.
psql_q "
  select round(total_exec_time::numeric, 1) as total_ms,
         calls,
         round(mean_exec_time::numeric, 3) as mean_ms,
         round((100 * total_exec_time / nullif(sum(total_exec_time) over (), 0))::numeric, 1) as pct,
         rows,
         round(coalesce(shared_blk_read_time, 0)::numeric, 1) as read_ms,
         left(regexp_replace(query, '\s+', ' ', 'g'), 200) as query
  from pg_stat_statements
  order by total_exec_time desc
  limit 25;" > "$OUT/pgss.tsv"

psql_q "
  select relname, seq_scan, seq_tup_read, idx_scan, n_tup_ins, n_tup_upd, n_live_tup,
         case when seq_scan > 0 then round((seq_tup_read::numeric / seq_scan), 1) else 0 end as avg_seq_rows
  from pg_stat_user_tables
  where seq_scan + coalesce(idx_scan, 0) > 0
  order by seq_tup_read desc;" > "$OUT/tables.tsv"

SAMPLES=$(wc -l < "$OUT/samples.jsonl" | tr -d ' ')
printf '{"label":"%s","started":%s,"ended":%s,"duration_sec":%s,"interval_sec":%s,"samples":%s,"pool_max":%s,"containers":{"app":"%s","postgres":"%s","redis":"%s"}}\n' \
  "$LABEL" "$START" "$(date +%s)" "$DURATION" "$INTERVAL" "$SAMPLES" "$POOL_MAX" \
  "$APP_CONTAINER" "$PG_CONTAINER" "$REDIS_CONTAINER" > "$OUT/meta.json"

echo "[capture] done — $SAMPLES samples, $OUT"
