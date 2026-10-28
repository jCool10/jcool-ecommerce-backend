# inventory-service

Owns stock and the checkout's TCC holds, from its own Postgres (`inventory-postgres`): `stock_levels`, `reservations` and the per-order fence `reservation_orders`. The api's checkout saga calls it over `/internal/v1/reservations`; the gateway sends `/admin/inventory*` here and answers `/internal/*` with 404 on the public listener.

## API

| Route | Answer |
| --- | --- |
| `POST /internal/v1/reservations/:orderId/try` | Body `{ lines: [{ variantId, quantity }], holdUntil }`, one line per variant, `holdUntil` an ISO timestamp in the future. `201 { outcome: "RESERVED" }`, also for a repeat on a `HELD` order. `409` with `OUT_OF_STOCK`, `CONTENDED` (optimistic retries ran out) or `CONFLICT` (the order is already past `HELD`). |
| `POST /internal/v1/reservations/:orderId/commit` | `HELD` to `COMMITTED`: on-hand and reserved drop together. |
| `POST /internal/v1/reservations/:orderId/release` | `HELD` to `RELEASED`. With no header it writes `FENCED`, so a Try that arrives later is refused. |
| `POST /internal/v1/reservations/:orderId/restock` | `COMMITTED` to `RESTOCKED`: on-hand comes back. |
| `POST /internal/v1/reservations/status` | Body `{ orderIds }`, 1 to 200 ids. `200 { statuses: { [orderId]: status or null } }`. |
| `GET /admin/inventory/:variantId` | `{ variantId, quantityOnHand, quantityReserved, available }`, `404` with no level. |
| `PUT /admin/inventory/:variantId` | Body `{ quantityOnHand }`. Creates or restates the level; `409` below what is reserved. |
| `POST /admin/inventory/:variantId/adjust` | Body `{ delta }`, non-zero. `404` for a level never set, `409` when it would oversell or go below zero. |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | As in the api. |

A command answers `200 { outcome }` with `APPLIED` or `IDEMPOTENT` (the header was already where it leads), and `409 CONFLICT` from a state it cannot move from. Every route is idempotent per order through `reservation_orders`, so retrying after a lost answer is safe. Anything the participant throws is `503` with `Retry-After: 1` and writes nothing. When rows another transaction held outlasted `INVENTORY_TRY_LOCK_TIMEOUT_MS`, the body carries `code: "LOCK_BUDGET_EXHAUSTED"` and the line is logged at warn: that is contention on a hot SKU, not a fault, and the api's breaker does not count it. A bare `503` (a database fault, say) is a fault.

`/internal/*` takes `Authorization: Bearer <INTERNAL_CALLER_TOKEN_API>`, or `INTERNAL_CALLER_TOKEN_API_PREVIOUS` while rotating. It is unthrottled: every call comes from the api's private addresses. `/admin/*` takes an `ADMIN` access token signed by the user-service, checked against its JWKS, the denylist and the session epoch in Redis; an epoch missing from Redis is read from the user-service with `USER_SERVICE_TOKEN`.

## Stock

The three CHECKs on `stock_levels` (`on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`) are the oversell guard; the code never trusts its own arithmetic. `INVENTORY_LOCK_STRATEGY=pessimistic` holds row locks; `optimistic` compares a `version` and retries up to `INVENTORY_OPTIMISTIC_MAX_RETRIES` before answering `CONTENDED`. Either way one Try spends a single `INVENTORY_TRY_LOCK_TIMEOUT_MS` across every lock wait.

A sweep releases `HELD` headers whose `hold_until` passed, every `INVENTORY_HOLD_SWEEP_INTERVAL_MS`. It only gives stock back; whether the order is over stays the api's call.

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
| `INTERNAL_CALLER_TOKEN_API` | required | The api's caller token, at least 32 characters. Without one the service refuses to boot. |
| `INTERNAL_CALLER_TOKEN_API_PREVIOUS` | unset | Also accepted, while the api moves to a new token. |
| `CATALOG_PUBLIC_URL` | required | Public catalog the stock seed lists variants from. |
| `INVENTORY_LOCK_STRATEGY` | `pessimistic` | Or `optimistic`. |
| `INVENTORY_OPTIMISTIC_MAX_RETRIES` | `3` | 0 to 10. |
| `INVENTORY_TRY_LOCK_TIMEOUT_MS` | `2000` | 100 to 30000. Keep it below the api's `CHECKOUT_TRY_TIMEOUT_MS`. |
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

In Compose, `docker compose up -d --build` runs it in-network as `inventory-service:3000` (published on 127.0.0.1:3004) after the one-shot `inventory-migrate`, and the gateway on 8080 routes `/admin/inventory*` to it. Don't run it on the host at the same time: both bind 3004. The api reaches it at `INVENTORY_SERVICE_URL` with `INVENTORY_SERVICE_TOKEN`, which must equal `INTERNAL_CALLER_TOKEN_API` here.
