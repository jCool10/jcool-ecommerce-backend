# order-service

Owns checkout and orders, from its own Postgres (`order-postgres`): `orders`, `order_items`, `idempotency_keys`, `outbox` and `inbox`. It orchestrates the checkout saga on Temporal, with the inventory-service and the payment-service as its two TCC participants, and it is the only consumer of the `order-events` queue. The gateway sends `/orders`, `/orders/*`, `/admin/orders` and `/admin/orders/*` here; the service has no public domain. Operator procedures are in the [RUNBOOK](../../RUNBOOK.md#the-order-service).

## API

| Route | Answer |
| --- | --- |
| `POST /orders` | Checks out the buyer's cart. Requires `Idempotency-Key`; a retry under the same key replays the first answer. `201` with the order once stock is held, `400` for an empty or unpurchasable cart, `409` for a key still in progress, too many pending orders or missing stock, `422` for a key reused with another request, `503` with `Retry-After` when the saga gave no answer within `CHECKOUT_RESERVE_WAIT_MS` or the api could not be read. |
| `GET /orders`, `GET /orders/:id` | The buyer's own orders. A `REJECTED` order answers `404`. |
| `POST /orders/:id/pay` | `201` with a Stripe Checkout Session, a new one or the one still open. `409` when the order is not `PENDING`, `502` when the payment-service failed. |
| `POST /orders/:id/cancel` | `200` with the order, also for one already cancelled; `409` once it has settled; `503` with `Retry-After` when the saga gave no answer within `CHECKOUT_CANCEL_WAIT_MS`. |
| `GET /admin/orders`, `GET /admin/orders/:id`, `POST /admin/orders/:id/cancel` | The same for an admin, over every buyer; the list filters by `status`. |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | As in the api, except that readiness also needs Temporal, and the saga worker `RUNNING` when it is enabled. |

Every route takes a bearer access token from the user-service. `POST /orders`, `/pay` and both cancels are throttled per IP (30 a minute) and per user (10 a minute); the rest share the default tier. Swagger is at `/docs` when `SWAGGER_ENABLED` is on.

## How a checkout runs

1. Before anything is written, the service reads the buyer's cart lines and the SKU views from the api's internal routes (`/internal/v1/carts/:userId/lines`, `/internal/v1/catalog/sku-views`, in batches of 100). Any answer but a `2xx` of the right shape is a `503`; a `4xx` or a body off its contract is logged at error, since it means configuration.
2. One transaction writes the order as `RESERVING` and claims the idempotency key, then the `CheckoutSaga` workflow `checkout-<order id>` starts in Temporal (namespace `TEMPORAL_NAMESPACE`, task queue `TEMPORAL_TASK_QUEUE`). The stock Try runs as a local activity against the inventory-service, within `CHECKOUT_TRY_TIMEOUT_MS` of `placedAt`.
3. The workflow is the only writer of the order's status from there: `PENDING` while it waits for `payment.authorized` or the payment deadline, then commit and capture, or compensation. The payment-service's relay puts `payment.authorized` on `order-events`, and this service's worker signals the saga with it.
4. `order.paid` sends the confirmation mail, with the buyer's address read from the user-service.

The reaper hands a `RESERVING` order whose start never reached Temporal back to its saga, and the invariant checker compares settled orders with both participants and only reports. A `lateAuthorization` run voids an authorization that arrives after its order closed; an order this database does not hold counts as not `PAID`, so such a run never captures.

## Ids

Every id is minted by the id-service through `ID_SERVICE_URL` with `x-caller: order-service`, before the transaction opens. There is no local generator in `src/`.

## Build

`pnpm --filter @jcool/order-service build` compiles with `tsc` and then writes the workflow bundle, `dist/workflows/checkout-saga.bundle.js`, which the worker loads in production. The image copies `dist` and the migrations; its pre-deploy command is `node dist/database/migrate-cli.js`.

## Configuration

Besides the platform variables (`NODE_ENV`, `PORT`, `DATABASE_URL`, `DB_*`, `REDIS_URL`, `LOG_LEVEL`, `TRUST_PROXY`, `METRICS_TOKEN`, `LOKI_URL`, `SHUTDOWN_GRACE_PERIOD_MS`, `BREAKER_*`, `THROTTLE_ENABLED`, `SWAGGER_ENABLED`, `SMTP_URL`, `MAIL_FROM`, `MAIL_TIMEOUT_MS`), with every default in [`src/config/configuration.ts`](./src/config/configuration.ts) and [`src/config/checkout-saga.config.ts`](./src/config/checkout-saga.config.ts):

| Variable | Default | |
| --- | --- | --- |
| `DB_POOL_MAX` | `16` | Must cover `QUEUE_WORKER_CONCURRENCY` + `SAGA_ACTIVITY_CONCURRENCY` + `SAGA_LOCAL_ACTIVITY_CONCURRENCY` + 5. |
| `TRUST_PROXY` | required in production | The per-IP throttle would otherwise key every buyer on the gateway. |
| `ID_SERVICE_URL`, `ID_SERVICE_TIMEOUT_MS` | required, `2000` | The gateway's internal listener, never a replica. |
| `AUTH_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | required | What the user-service signs. |
| `USER_SERVICE_URL`, `USER_SERVICE_TOKEN` | required | Session epochs on a Redis miss and the buyer's address for `order.paid`. The token is the user-service's `INTERNAL_CALLER_TOKEN_ORDER_SERVICE`, at least 32 characters. |
| `USER_SERVICE_TIMEOUT_MS`, `USER_DIRECTORY_NOT_FOUND_GRACE` | `500`, `10m` | |
| `API_SERVICE_URL`, `API_SERVICE_TOKEN` | required | The api's private address, never the gateway. The token is the api's `INTERNAL_CALLER_TOKEN_ORDER_SERVICE`. |
| `API_SERVICE_TIMEOUT_MS` | `2000` | Per call; its breaker allows 1000 more. |
| `INVENTORY_SERVICE_URL`, `INVENTORY_SERVICE_TOKEN` | required | The token is the inventory-service's `INTERNAL_CALLER_TOKEN_ORDER_SERVICE`. |
| `INVENTORY_COMMAND_TIMEOUT_MS` | `5000` | Commit, release, restock and status; a Try is bounded by `CHECKOUT_TRY_TIMEOUT_MS`. |
| `PAYMENT_SERVICE_URL`, `PAYMENT_SERVICE_TOKEN` | required | The token is the payment-service's `INTERNAL_CALLER_TOKEN_ORDER_SERVICE`. |
| `PAYMENT_COMMAND_TIMEOUT_MS` | `45000` | A cancel there chains up to four Stripe calls. |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` | `localhost:7233`, `jcool`, `checkout-saga` | Required in production. |
| `TEMPORAL_WORKER_ENABLED` | `true` | |
| `TEMPORAL_WORKER_SHUTDOWN_GRACE_MS`, `TEMPORAL_WORKER_SHUTDOWN_FORCE_MS` | `4000`, `4000` | Part of the shutdown budget below. |
| `CHECKOUT_*`, `SAGA_*` | see `checkout-saga.config.ts` | The payment deadline, the Try and wait budgets, the reaper and the saga's retries. |
| `CHECKOUT_INVARIANT_*` | enabled, every minute | `CHECKOUT_INVARIANT_NOT_BEFORE` is unset outside a cut-over. |
| `QUEUE_PREFIX` | `bull` | Must equal the payment-service's, or this worker never sees `payment.authorized`. |
| `QUEUE_WORKER_ENABLED`, `QUEUE_WORKER_CONCURRENCY`, `QUEUE_CONSUMER_*` | `true`, `5`, 8 attempts from 1000 ms | |
| `ORDER_PAID_CONSUMER_ATTEMPTS`, `ORDER_PAID_CONSUMER_BACKOFF_CAP_MS` | `15`, `300000` | The long ladder of `order.paid` and `payment.authorized`, about 33 minutes. Keep the attempts equal to the payment-service's. |
| `OUTBOX_RELAY_ENABLED`, `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE` | `true`, `1000`, `100` | |
| `RETENTION_IDEMPOTENCY_GRACE_SEC`, `RETENTION_REJECTED_ORDER_DAYS`, `RETENTION_OUTBOX_DAYS`, `RETENTION_INBOX_DAYS` | `3600`, `30`, `30`, `30` | The inbox window has a floor of 7 days. |

Env validation checks every rule between these at boot, among them `SAGA_ACTIVITY_TIMEOUT_MS` above each command timeout plus 5000 and above each breaker timeout. Three rules span services, so nothing checks them ([RUNBOOK → Cross-service settings](../../RUNBOOK.md#cross-service-settings)):

- 4 × the payment-service's `PAYMENT_CAPTURE_TIMEOUT_MS` + 1000 ≤ `PAYMENT_COMMAND_TIMEOUT_MS`.
- The inventory-service's `INVENTORY_TRY_LOCK_TIMEOUT_MS` < `CHECKOUT_TRY_TIMEOUT_MS`.
- `SHUTDOWN_GRACE_PERIOD_MS` + `TEMPORAL_WORKER_SHUTDOWN_GRACE_MS` + `TEMPORAL_WORKER_SHUTDOWN_FORCE_MS` + 1000 + 2 × 5000 (closing the `order-events` worker) ≤ `drainingSeconds` × 1000 − 1000, with `drainingSeconds` 30 in `.railway/railway.ts`: 24000 ≤ 29000 at the defaults.

## Local

On the host it listens on 3006, with `order-postgres` on 5437. It needs Redis, Temporal, the id-service and the four services it calls:

```bash
cp apps/order-service/.env.example apps/order-service/.env
docker compose up -d order-postgres redis temporal
pnpm --filter @jcool/order-service build
pnpm --filter @jcool/order-service db:migrate
pnpm --filter @jcool/order-service start
pnpm --filter @jcool/order-service test        # unit, including the workflow replay of replay-histories/
pnpm --filter @jcool/order-service test:e2e    # Postgres, Redis and a Temporal dev server, all started by the suite
pnpm queue:replay-dlq:order --queue order-events   # dry run of order-events-dlq
```

In Compose, `docker compose up -d --build` runs it in-network as `order-service:3000` (published on 127.0.0.1:3006) after the one-shot `order-migrate`, with `NODE_ENV=production`, and the gateway on 8080 routes the order paths to it. Its tokens there are fixed local values that match the callees'.
