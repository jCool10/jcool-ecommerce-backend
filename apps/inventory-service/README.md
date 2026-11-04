# inventory-service

Owns stock and the checkout's TCC holds, from its own Postgres (`inventory-postgres`): `stock_levels`, `reservations` and the per-order fence `reservation_orders`. The order-service's checkout saga calls it over `/internal/v1/reservations`; the gateway sends `/admin/inventory*` here and answers `/internal/*` with 404 on the public listener.

## API

| Route | Answer |
| --- | --- |
| `POST /internal/v1/reservations/:orderId/try` | Body `{ lines: [{ variantId, quantity }], holdUntil }`, one line per variant and at most 100 lines, `holdUntil` an ISO timestamp in the future. `201 { outcome: "RESERVED" }`, also for a repeat on a `HELD` order. `409` with `OUT_OF_STOCK`, `CONTENDED` (optimistic retries ran out) or `CONFLICT` (the order is already past `HELD`). |
| `POST /internal/v1/reservations/:orderId/commit` | `HELD` to `COMMITTED`: on-hand and reserved drop together. |
| `POST /internal/v1/reservations/:orderId/release` | `HELD` to `RELEASED`. With no header it writes `FENCED`, so a Try that arrives later is refused. |
| `POST /internal/v1/reservations/:orderId/restock` | `COMMITTED` to `RESTOCKED`: on-hand comes back. |
| `POST /internal/v1/reservations/status` | Body `{ orderIds }`, 1 to 200 ids. `200 { statuses: { [orderId]: status or null } }`. |
| `GET /admin/inventory/:variantId` | `{ variantId, quantityOnHand, quantityReserved, available }`, `404` with no level. |
| `PUT /admin/inventory/:variantId` | Body `{ quantityOnHand }`, 0 to 1,000,000,000. Creates or restates the level; `409` below what is reserved. |
| `POST /admin/inventory/:variantId/adjust` | Body `{ delta }`, non-zero and within 1,000,000,000 either way. `404` for a level never set, `409` when it would oversell, go below zero or pass 1,000,000,000. |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | As in the api. |

A command answers `200 { outcome }` with `APPLIED` or `IDEMPOTENT` (the header was already where it leads), and `409 CONFLICT` from a state it cannot move from. Every route is idempotent per order through `reservation_orders`, so retrying after a lost answer is safe. Anything the participant throws is `503` with `Retry-After: 1` and writes nothing, and the `code` says whose fault it was. `LOCK_BUDGET_EXHAUSTED` means rows another transaction held outlasted `INVENTORY_TRY_LOCK_TIMEOUT_MS`: that is contention on a hot SKU, logged at warn, and the caller's breaker does not count it. `ID_SERVICE_UNAVAILABLE` means a Try could not get its ids from the id-service; only a Try mints, so the breaker that Commit and Release share does not count it either. A bare `503` (a database fault, a pool wait, a statement that ran long without waiting on a lock) is a fault and counts. The lock budget starts after the ids are minted, so a slow id-service cannot spend it.

`/internal/*` takes `Authorization: Bearer <INTERNAL_CALLER_TOKEN_ORDER_SERVICE>` from the order-service, its only caller; `_PREVIOUS` is also accepted while rotating. It is unthrottled: every call comes from a private address. `/admin/*` takes an `ADMIN` access token signed by the user-service, checked against its JWKS, the denylist and the session epoch in Redis; an epoch missing from Redis is read from the user-service with `USER_SERVICE_TOKEN`. An admin write that would break a `CHECK` answers `409`, not `500`: the constraint is the authority on what a level may become, and a violation is a fact about stock rather than a malformed request.

## Stock

The three CHECKs on `stock_levels` (`on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`) are the oversell guard; the code never trusts its own arithmetic. `INVENTORY_LOCK_STRATEGY=pessimistic` holds row locks; `optimistic` compares a `version` and retries up to `INVENTORY_OPTIMISTIC_MAX_RETRIES` before answering `CONTENDED`. Either way one Try spends a single `INVENTORY_TRY_LOCK_TIMEOUT_MS` across every lock wait. Each statement gets `lock_timeout` of what is left of it and a `statement_timeout` 250 ms longer, so a lock wait always ends as the lock error and only a slow statement hits the statement one. A restock sums as bigint and clamps at the column's limit, so a high level cannot make it fail.

A sweep releases `HELD` headers whose `hold_until` passed, every `INVENTORY_HOLD_SWEEP_INTERVAL_MS`. It only gives stock back; whether the order is over stays the order-service's call.

## Ids

Every id is minted by the id-service through `ID_SERVICE_URL` with `x-caller: inventory-service`, before the transaction opens, so no lock waits on the network. There is no local generator in `src/`, and dependency-cruiser keeps it that way.

## Configuration

Besides the platform variables (`NODE_ENV`, `PORT`, `DATABASE_URL`, `DB_*`, `REDIS_URL`, `LOG_LEVEL`, `TRUST_PROXY`, `THROTTLE_*`, `METRICS_TOKEN`, `LOKI_URL`, `SHUTDOWN_GRACE_PERIOD_MS`, `BREAKER_*`):

| Variable | Default | |
| --- | --- | --- |
| `ID_SERVICE_URL` | required | The gateway's internal listener, never a replica. |
| `ID_SERVICE_TIMEOUT_MS` | `2000` | |
| `AUTH_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | required | The user-service's JWKS and the claims it stamps. |
| `USER_SERVICE_URL` | required | For the epoch read only. |
| `USER_SERVICE_TOKEN` | required | The user-service's `INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE`. At least 32 characters. |
| `USER_SERVICE_TIMEOUT_MS` | `500` | |
| `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` | required | The order-service's `INVENTORY_SERVICE_TOKEN`, at least 32 characters. Optional to env validation, but the guard refuses to boot without it. |
| `INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS` | unset | Also accepted, while the order-service moves to a new token. |
| `CATALOG_PUBLIC_URL` | required | Public catalog the stock seed lists variants from. |
| `INVENTORY_LOCK_STRATEGY` | `pessimistic` | Or `optimistic`. |
| `INVENTORY_OPTIMISTIC_MAX_RETRIES` | `3` | 0 to 10. |
| `INVENTORY_TRY_LOCK_TIMEOUT_MS` | `2000` | 100 to 30000. Keep it below the order-service's `CHECKOUT_TRY_TIMEOUT_MS`. |
| `INVENTORY_HOLD_SWEEP_ENABLED` | `true` | |
| `INVENTORY_HOLD_SWEEP_INTERVAL_MS` | `60000` | |
| `INVENTORY_HOLD_SWEEP_BATCH_SIZE` | `50` | 1 to 500. |

## Scripts

| Script | |
| --- | --- |
| `db:migrate` | Applies `src/database/migrations`. |
| `db:seed` | Gives every variant the public catalog lists a level of 1,000,000,000 if it has none; never touches an existing level. Fails on a catalog that cannot be listed or lists nothing. Railway's pre-deploy (`dist/database/pre-deploy-cli.js`) migrates and then runs it best effort, which skips the seed instead. |

## Local

On the host it listens on 3004, with `inventory-postgres` on 5435; the root [Quick start](../../README.md#quick-start) brings both up next to the other services. Alone:

```bash
cp apps/inventory-service/.env.example apps/inventory-service/.env
docker compose up -d inventory-postgres redis
pnpm --filter @jcool/inventory-service build
pnpm --filter @jcool/inventory-service db:migrate
pnpm --filter @jcool/inventory-service start
pnpm --filter @jcool/inventory-service db:seed     # needs the catalog at CATALOG_PUBLIC_URL and the id-service at ID_SERVICE_URL
pnpm --filter @jcool/inventory-service test        # unit
pnpm --filter @jcool/inventory-service test:e2e    # Postgres and Redis via Testcontainers
```

In Compose, `docker compose up -d --build` runs it in-network as `inventory-service:3000` (published on 127.0.0.1:3004) after the one-shot `inventory-migrate`, and the gateway on 8080 routes `/admin/inventory*` to it. Don't run it on the host at the same time: both bind 3004. The order-service reaches it at `INVENTORY_SERVICE_URL` with `INVENTORY_SERVICE_TOKEN`, which must equal `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` here.
