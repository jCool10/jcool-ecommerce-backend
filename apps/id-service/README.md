# id-service

Mints 63-bit integer ids (layout in [`@jcool/id-codec`](../../packages/id-codec): `41 ts_ms │ 12 bucket │ 5 node │ 5 seq`) under a 5-bit node id leased from the service's own Postgres. It runs as three or more stateless replicas behind the private load balancer in [`apps/gateway`](../gateway). No id is stamped past its holder's lease end, and the next holder of a node starts above that end, so no id and no `(ts, node, seq)` triple is ever issued twice, whatever the replicas' clocks say.

The layout carries no random bits, so that lease is the *whole* of the uniqueness argument: a node belongs to one holder at a time, and a new holder is floored past the previous holder's entire lease window rather than past what it last reported minting.

An id is returned as a **decimal string**, not a JSON number. 63 bits outruns the 53 a JSON number holds exactly, about 25 days past the 2026-01-01 epoch, so a client that parses one as a number silently loses its last digits.

## API

| Route | Answer |
| --- | --- |
| `POST /v1/ids` `{ "bucket": 0..4095, "count"?: 1..32 }` | `200 { "ids": [...] }`, decimal strings, each carrying the bucket that was sent. The cap is one node-millisecond: the sequence holds 32 ids per millisecond, and a larger batch would busy-wait into the next one with the event loop blocked. `400` for anything outside those ranges or any extra field. `503 { "code": "LEASE_NOT_HELD" }` when this replica holds no usable lease; the gateway retries the request on another replica. |
| `GET /health/live` | `200` while the process runs. |
| `GET /health/ready` | `200` while the replica holds an unfenced lease, including while it drains. `503` with the lease state otherwise. |
| `GET /metrics` | Prometheus, guarded by `METRICS_TOKEN` as in the api. |

The `x-caller` header labels `id_minted_total`. A value outside `^[a-z][a-z0-9-]{0,31}$` is counted as `unknown`.

**No service-to-service auth.** The service has no public domain. It is reachable only on the private network, through the gateway's internal listener. It holds no user data and no secrets, and an id is not a secret. Network isolation is therefore the control, and adding a token would add a secret to rotate without protecting anything. If the service is ever exposed beyond the private network, this decision has to be revisited.

The service never receives an email and never logs the ids it mints.

## The node lease

`node_leases` has one row per node id from 1 to 30; 0 and 31 stay reserved for the api and scripts. The table is seeded by migration. Every operation is a single SQL statement, and every time comparison uses the database clock.

- **Acquire** claims the node that expired longest ago, and only after the quarantine has passed. It uses `FOR UPDATE SKIP LOCKED` and bumps `generation`. A holder is identified by its generation, never by its name.
- **Renew** runs every `ID_LEASE_RENEW_EVERY_MS` and records the last timestamp minted in `max_ts_ms`. If the lease has already expired, renew returns *lost*: minting stops immediately and the replica claims another node.
- **The fence** is checked before and after every mint, against the local monotonic and wall clocks, measured from the moment the last successful renew started. A replica stops minting at `ttl − fenceMargin`, before the database could give its node to anyone else, and does so even if the database has stopped answering. A wall clock that runs ahead of the monotonic clock by more than the margin (a host resumed from suspend) also fences the replica, until a renew succeeds. So does an id stamped past the lease end the database last reported; that id is discarded.
- **The floor**: a new holder starts minting above `max(max_ts_ms, the previous lease end, its own last timestamp)`. The lease end covers ids a holder minted after its last renew and never reported, because it crashed or lost the database. If `max_ts_ms` is more than `ID_LEASE_MAX_FLOOR_AHEAD_MS` ahead of the database clock, the node is handed back and another one is claimed a second later.
- **Shutdown**: on `SIGTERM` the replica keeps minting for `SHUTDOWN_GRACE_PERIOD_MS`, then the HTTP server closes. The lease is released with its floor recorded, and only then does the database pool end.

## Configuration

Besides the platform variables (`NODE_ENV`, `PORT`, `DATABASE_URL`, `DB_*`, `LOG_LEVEL`, `METRICS_TOKEN`, `SHUTDOWN_GRACE_PERIOD_MS`):

| Variable | Default | |
| --- | --- | --- |
| `ID_LEASE_TTL_MS` | `300000` | Lease length granted by the database. |
| `ID_LEASE_RENEW_EVERY_MS` | `60000` | Must stay below `TTL − FENCE_MARGIN`, or the service refuses to boot. |
| `ID_LEASE_QUARANTINE_MS` | `10000` | How long an expired or released node rests before it is claimed again. |
| `ID_LEASE_FENCE_MARGIN_MS` | `15000` | How long before expiry the replica stops minting on its own. |
| `ID_LEASE_MAX_FLOOR_AHEAD_MS` | fence margin | Inherited floors further ahead than this are rejected. |
| `DB_QUERY_TIMEOUT_MS` | `2000` | Bounds a renew against a database that hangs. At least 1, as is `DB_POOL_CONNECTION_TIMEOUT_MS`: 0 waits forever and stalls the lease. |

On a rolling deploy, keep `SHUTDOWN_GRACE_PERIOD_MS` < the platform's draining window < `ID_LEASE_FENCE_MARGIN_MS`.

## Operations

- **Migrate** before starting replicas: `node dist/database/migrate-cli.js` (`MIGRATIONS_DIR=/app/migrations` in the image). It exits non-zero if it finds no migrations at all.
- **Pool exhausted**: readiness returns `503 {state: "exhausted"}`, the keeper logs one error, and it retries every second. The usual cause is crashed replicas whose leases have not expired yet; they free up after `TTL + quarantine`.
- **Database down**: replicas keep minting until the fence, then answer `LEASE_NOT_HELD`. Once the database is back, they either renew or claim a new node.
- **Database restored or recreated**: its rows can sit behind ids already minted. Follow the [runbook](../../RUNBOOK.md#restoring-or-recreating-the-id-service-database) before any replica starts.

| Metric | Meaning |
| --- | --- |
| `id_lease_state{state}` | 1 on the current state (`held`, `draining`, `fenced`, `lost`, `exhausted`, …). |
| `id_lease_node_info{node_id}` | The node currently held. |
| `id_lease_renew_failures_total` | Renewals that failed to reach the database. |
| `id_lease_lost_total` | Renewals that found the lease expired or taken. |
| `id_lease_floor_rejections_total` | Nodes handed back because of an inherited floor. |
| `id_fence_rejections_total` | Requests answered `503 LEASE_NOT_HELD`. |
| `id_minted_total{caller}` | Ids minted. |
| `id_clock_drift_ms`, `id_clock_stall_total` | The generator's clock health; the alerts in `infra/prometheus/rules/identity.yml` apply as-is. |

## Local

```bash
docker compose up -d --build id-service gateway   # id-postgres, a one-shot migrate, 3 replicas, the gateway
pnpm --filter @jcool/id-service test              # unit
pnpm --filter @jcool/id-service test:e2e          # Postgres via Testcontainers, including a paused database
pnpm --filter @jcool/id-service test:system       # built images, 3 replicas behind the gateway
```
