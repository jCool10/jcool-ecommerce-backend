# id-service

Mints 63-bit integer ids (layout in [`@jcool/id-codec`](../../packages/id-codec): `45 ts_ms │ 8 node │ 10 seq`) under an 8-bit node id leased from etcd. It runs as three or more stateless replicas behind the private load balancer in [`apps/gateway`](../gateway). No id is stamped past the ceiling its holder reserved in etcd, and the next holder of a node starts above that ceiling, so no id and no `(ts, node, seq)` triple is ever issued twice, whatever the replicas' clocks say.

The layout carries no random bits, so that lease is the *whole* of the uniqueness argument: a node belongs to one holder at a time, and a new holder is floored past the previous holder's entire reservation rather than past what it last reported minting.

An id is returned as a **decimal string**, not a JSON number. 63 bits outruns the 53 a JSON number holds exactly, about 13 months past the 2026-01-01 epoch, so a client that parses one as a number silently loses its last digits.

## API

| Route | Answer |
| --- | --- |
| `POST /v1/ids` `{ "count"?: 1..1024 }` | `200 { "ids": [...] }`, decimal strings. The cap is one node-millisecond: the sequence holds 1024 ids per millisecond, so a request busy-waits into the next one at most once; with the stamping itself, a full batch holds the event loop for a few milliseconds. A larger batch would add a millisecond per 1024 ids. `400` for anything outside those ranges or any extra field. `503 { "code": "LEASE_NOT_HELD" }` when this replica holds no usable lease; the gateway retries the request on another replica. |
| `GET /health/live` | `200` while the process runs. |
| `GET /health/ready` | `200` while the replica holds an unfenced lease, including while it drains. `503` with the lease state otherwise. |
| `GET /metrics` | Prometheus, guarded by `METRICS_TOKEN` as in the api. |

The `x-caller` header labels `id_minted_total`. A value outside `^[a-z][a-z0-9-]{0,31}$` is counted as `unknown`.

**No service-to-service auth.** The service has no public domain. It is reachable only on the private network, through the gateway's internal listener. It holds no user data and no secrets, and an id is not a secret. Network isolation is therefore the control, and adding a token would add a secret to rotate without protecting anything. If the service is ever exposed beyond the private network, this decision has to be revisited. The same holds for etcd, which runs without auth or TLS on the private network and holds only node owners and floors.

The service never receives an email and never logs the ids it mints.

## The node lease

Under `ETCD_KEY_PREFIX` each node id from 1 to 254 has two keys, `nodes/NNN/owner` and `nodes/NNN/floor`, and an `initialized` marker sits beside them; 0 and 255 are never leased. Seed scripts mint on 255 under an advisory lock; 0 is unused, since the api and the user-service both mint through this service. etcd has no clock a client can read, so the lease rests on two things: the owner key, attached to an etcd lease that etcd deletes once its holder stops keeping it alive, and the floor, a timestamp in the ids' own domain that every claim and renew raises to the holder's ceiling before the holder may stamp up to it.

- **Acquire** reads the whole keyspace and claims the free node whose floor was written longest ago, never-leased ones first, then the lowest id. The claim is one transaction guarded by both keys: the owner must be absent and the floor unchanged since the read. It puts the owner under a fresh etcd lease of `ID_LEASE_TTL_MS`, rounded up to seconds, and raises the floor to the ceiling, `max(now, floor) + TTL`. The owner's create revision is the holder's generation, so a renew or release from an earlier holder matches nothing. After a lost race it tries a random remaining node, so replicas that start together spread out.
- **Re-adopt**: a claim can commit after the client's `ETCD_REQUEST_TIMEOUT_MS` has given up on it. The replica keeps the etcd lease it claimed with until a claim is confirmed, and its retry first looks for an owner under that lease, then re-adopts that node with a raised ceiling instead of claiming a second one.
- **Renew** runs every `ID_LEASE_RENEW_EVERY_MS`. It checks the generation, keeps the etcd lease alive, and raises the floor to `max(now, last minted) + TTL`, the new ceiling; it never lowers it. A renew that finds the owner gone or replaced returns *lost*: minting stops immediately and the replica claims another node.
- **The fence** is checked before and after every mint, against the local monotonic and wall clocks, measured from the moment the last successful renew started. A replica stops minting at `ttl − fenceMargin`, before its etcd lease could lapse, and does so even if etcd has stopped answering. A wall clock that runs ahead of the monotonic clock by more than the margin (a host resumed from suspend) also fences the replica, until a renew succeeds. So does an id stamped past the ceiling the store last confirmed; that id is discarded.
- **The floor**: a new holder starts minting above `max(floor, its own last timestamp)`. The floor is the previous holder's ceiling, so it covers ids minted after the last renew by a holder that crashed or lost etcd, and no quarantine is needed: a released node is free at once, an expired one as soon as etcd drops its owner. A clean release lowers the floor to the last id minted, never below the floor its claim found, so the next holder is not floored a TTL ahead. If the floor is more than `ID_LEASE_MAX_FLOOR_AHEAD_MS` ahead of the replica's clock, the node is handed back with its floor untouched and another one is claimed a second later.
- **An empty keyspace** has no `initialized` marker, and acquire refuses to claim on it: its floors know nothing of ids minted before it was wiped. `lift-floors-cli` lifts every floor to the clock, refuses while any node is held, and writes the marker last.
- **Shutdown**: on `SIGTERM` the replica keeps minting for `SHUTDOWN_GRACE_PERIOD_MS`, then the HTTP server closes. The node is released with its floor recorded, and only then does the etcd client close.

## Configuration

Besides the platform variables (`NODE_ENV`, `PORT`, `LOG_LEVEL`, `METRICS_TOKEN`, `SHUTDOWN_GRACE_PERIOD_MS`):

| Variable | Default | |
| --- | --- | --- |
| `ETCD_ENDPOINTS` | — | Required. Comma-separated `http(s)://host:port` URLs. |
| `ETCD_KEY_PREFIX` | `/jcool/id-service/` | Starts and ends with `/`. Every replica minting into the same id space shares one. |
| `ETCD_REQUEST_TIMEOUT_MS` | `2000` | Deadline on every etcd call, so a renew against an etcd that hangs fails well before the fence. At least 1. |
| `ID_LEASE_TTL_MS` | `300000` | How far ahead a claim or renew reserves, and the etcd lease's TTL. |
| `ID_LEASE_RENEW_EVERY_MS` | `60000` | Must stay below `TTL − FENCE_MARGIN`, or the service refuses to boot. |
| `ID_LEASE_FENCE_MARGIN_MS` | `15000` | How long before the ceiling the replica stops minting on its own. |
| `ID_LEASE_MAX_FLOOR_AHEAD_MS` | fence margin | Inherited floors further ahead than this are rejected. |

On a rolling deploy, keep `SHUTDOWN_GRACE_PERIOD_MS` < the platform's draining window < `ID_LEASE_FENCE_MARGIN_MS`.

## Operations

- **Floors** before the first replica: the pre-deploy step runs `node dist/lease/lift-floors-cli.js --if-uninitialized`, a no-op once the keyspace has its marker. Without the flag it lifts a keyspace that has one too. Locally, after a build: `pnpm --filter @jcool/id-service lease:lift-floors`.
- **Pool exhausted**: readiness returns `503 {state: "exhausted"}`, the keeper logs one error, and it retries every second. The usual cause is crashed replicas whose etcd leases have not expired yet. A replica that exits without releasing (a crash, an OOM kill, `SIGKILL`) keeps its node for up to the TTL, 300 s by default, so with 3 replicas holding nodes about 251 such exits inside that window exhaust the 254-node pool. Railway restarts a crashing replica at most 5 times, so one bad deploy locks at most 18.
- **etcd down**: replicas keep minting until the fence, then answer `LEASE_NOT_HELD`. Once etcd is back, they either renew or claim a new node. A restart that keeps etcd's data keeps every owner, and etcd restarts each lease's TTL.
- **etcd wiped or replaced**: the replicas stop claiming until the floors are lifted. Follow the [runbook](../../RUNBOOK.md#the-keyspace-is-lost); never restore a snapshot into it.

| Metric | Meaning |
| --- | --- |
| `id_lease_state{state}` | 1 on the current state (`held`, `draining`, `fenced`, `lost`, `exhausted`, …). |
| `id_lease_node_info{node_id}` | The node currently held. |
| `id_lease_renew_failures_total` | Renewals that failed to reach etcd. |
| `id_lease_lost_total` | Renewals that found the owner gone or replaced. |
| `id_lease_floor_rejections_total` | Nodes handed back because of an inherited floor. |
| `id_fence_rejections_total` | Requests answered `503 LEASE_NOT_HELD`. |
| `id_minted_total{caller}` | Ids minted. |
| `id_clock_drift_ms`, `id_clock_stall_total` | The generator's clock health; the alerts in `infra/prometheus/rules/identity.yml` apply as-is. |

## Local

```bash
docker compose up -d --build id-service gateway   # id-etcd, a one-shot floor lift, 3 replicas, the gateway
pnpm --filter @jcool/id-service test              # unit
pnpm --filter @jcool/id-service test:e2e          # etcd via Testcontainers, including a paused etcd
pnpm --filter @jcool/id-service test:system       # built images, 3 replicas behind the gateway
```
