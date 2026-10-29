# payment-service

Owns payments and the checkout's TCC payment branch, from its own Postgres (`payment-postgres`): `payment_orders` (the per-order fence), `payments`, `webhook_events` and `outbox`. The api's checkout saga calls it over `/internal/v1/payments`; the gateway sends `POST /webhooks/payment` here and answers `/internal/*` with 404 on the public listener. Money is held with a Stripe Checkout Session in manual-capture mode and only moved by an explicit capture.

## API

| Route | Answer |
| --- | --- |
| `POST /internal/v1/payments/:orderId/session` | Body `{ amountMinor, currency, expiresAt }`. `200 { outcome: "OPENED", paymentId, providerSessionId, redirectUrl, clientSecret }`; a repeat while Stripe still offers the session answers the same attempt without `clientSecret`. `409 { outcome: "CLOSED" }` when the order is past `OPEN`, the charge differs from the first open, or `expiresAt` is closer than `PAYMENT_SESSION_MIN_TTL_SEC + PAYMENT_SESSION_EXPIRY_MARGIN_SEC`. |
| `POST /internal/v1/payments/:orderId/capture` | `AUTHORIZED` to `CAPTURED`. `200` with `CAPTURED` or `IDEMPOTENT`; `409` with `NOT_CAPTURABLE` (the hold is gone, or the order was cancelled or fenced) or `CONFLICT` (nothing authorized yet). |
| `POST /internal/v1/payments/:orderId/cancel` | Voids a hold. `200` with `CANCELLED`, `FENCED` (no header yet, so a later open is refused) or `IDEMPOTENT`; `409 CAPTURED_CONFLICT` once the money moved. |
| `POST /internal/v1/payments/status` | Body `{ orderIds }`, 1 to 200 ids. `200 { statuses: { [orderId]: { header, authorizedPaymentId, hasAuthorizedAttempt, hasSucceededAttempt } } }`, `header` `null` for an order it never saw. |
| `POST /webhooks/payment` | Stripe's events, verified over the raw body with `PAYMENT_WEBHOOK_SECRET`. `200` once accepted (including a duplicate), `401` on a bad signature or a stale timestamp, `503` when Stripe could not confirm the event yet. |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | As in the api. |

Every command is idempotent per order through `payment_orders`, so retrying after a lost answer is safe. `400` is a malformed id or body. Anything the participant throws is `503` with `Retry-After: 1`; the caller repeats it, which is safe. When Stripe failed or its breaker is open, the body carries `code: "PROVIDER_UNAVAILABLE"`, so the api's `payment-service` breaker does not count it: the service itself is up, and status reads and cancels that need no Stripe still answer.

`/internal/*` takes `Authorization: Bearer <INTERNAL_CALLER_TOKEN_API>`, or `INTERNAL_CALLER_TOKEN_API_PREVIOUS` while rotating. Nothing is throttled: the api calls from private addresses, and Stripe only retries harder when refused.

## Events

An authorization recorded from a webhook writes `payment.authorized` to `outbox` in the same transaction. The relay moves it onto the api's `order-events` queue in the shared Redis, on the long ladder (`ORDER_PAID_CONSUMER_ATTEMPTS` attempts, `order-paid` backoff), where the api signals the checkout saga. The service consumes no queue, so it runs no worker and has no inbox; webhook deduplication lives in `webhook_events`.

## Ids

Every id is minted by the id-service through `ID_SERVICE_URL` with `x-caller: payment-service`, before the transaction opens. There is no local generator in `src/`.

## Configuration

Besides the platform variables (`NODE_ENV`, `PORT`, `DATABASE_URL`, `DB_*`, `REDIS_URL`, `LOG_LEVEL`, `TRUST_PROXY`, `METRICS_TOKEN`, `LOKI_URL`, `SHUTDOWN_GRACE_PERIOD_MS`, `BREAKER_*`, `RETENTION_*`):

| Variable | Default | |
| --- | --- | --- |
| `ID_SERVICE_URL` | required | The gateway's internal listener, never a replica. |
| `ID_SERVICE_TIMEOUT_MS` | `2000` | |
| `INTERNAL_CALLER_TOKEN_API` | required | The api's `PAYMENT_SERVICE_TOKEN`, at least 32 characters. Without one the service refuses to boot. |
| `INTERNAL_CALLER_TOKEN_API_PREVIOUS` | unset | Also accepted, while the api moves to a new token. |
| `QUEUE_PREFIX` | `bull` | Must equal the api's. |
| `ORDER_PAID_CONSUMER_ATTEMPTS` | `15` | 1 to 30. Stamped on every `payment.authorized` job; keep it equal to the api's. |
| `OUTBOX_RELAY_ENABLED`, `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE` | `true`, `1000`, `100` | |
| `PAYMENT_WEBHOOK_SECRET` | required | At least 16 characters. |
| `PAYMENT_WEBHOOK_TOLERANCE_SEC` | `300` | |
| `STRIPE_SECRET_KEY`, `STRIPE_SUCCESS_URL` | unset | Required in production. Unset in development and test, sessions are fabricated without calling Stripe and every capture or void fails closed. |
| `STRIPE_CANCEL_URL` | `http://localhost:3000/payments/cancel` | |
| `PAYMENT_SESSION_MIN_TTL_SEC`, `PAYMENT_SESSION_EXPIRY_MARGIN_SEC` | `1800`, `120` | Stripe refuses a session under 30 minutes. |
| `PAYMENT_CAPTURE_TIMEOUT_MS` | `10000` | Per Stripe call; the SDK takes no abort signal. |
| `RECONCILE_ENABLED`, `RECONCILE_INTERVAL_MS`, `RECONCILE_BATCH_SIZE`, `ORDER_STALE_THRESHOLD_SEC` | `true`, `60000`, `50`, `120` | Polls Stripe for sessions whose webhook never came. |
| `RETENTION_OUTBOX_DAYS`, `RETENTION_WEBHOOK_EVENT_DAYS` | `30`, `30` | The webhook ledger is the replay defence, so at least 14 days. |

## Local

On the host it listens on 3005, with `payment-postgres` on 5436. Alone:

```bash
cp apps/payment-service/.env.example apps/payment-service/.env
docker compose up -d payment-postgres redis
pnpm --filter @jcool/payment-service build
pnpm --filter @jcool/payment-service db:migrate
pnpm --filter @jcool/payment-service start
pnpm --filter @jcool/payment-service test        # unit
pnpm --filter @jcool/payment-service test:e2e    # Postgres and Redis via Testcontainers
```

In Compose, `docker compose up -d --build` runs it in-network as `payment-service:3000` (published on 127.0.0.1:3005) after the one-shot `payment-migrate`, and the gateway on 8080 routes `POST /webhooks/payment` to it. Compose runs it with `NODE_ENV=production`, so it refuses to boot without a `sk_test_` `STRIPE_SECRET_KEY` and a `STRIPE_SUCCESS_URL` in the root `.env`; it reads `PAYMENT_WEBHOOK_SECRET` and `STRIPE_CANCEL_URL` from there too. For Stripe test mode, run `stripe listen --forward-to localhost:8080/webhooks/payment` and set `PAYMENT_WEBHOOK_SECRET` to the `whsec_` it prints.
