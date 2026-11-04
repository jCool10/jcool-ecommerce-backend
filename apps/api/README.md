# api

The modular monolith: the Product (catalog and search), Cart and Media contexts, from its own Postgres, with Elasticsearch for search and an S3-compatible bucket for media. The gateway sends every path it does not route to another service here. The api verifies the user-service's ES256 tokens against its JWKS and reads session epochs from the shared Redis, asking the user-service's internal routes only on a miss; it holds no user rows, no signing key and no `/auth` route. Elasticsearch is private, and the api reaches it as a user limited to `products*`. What each context owns: [system-architecture.md → Bounded contexts](../../docs/system-architecture.md#bounded-contexts); where its code lives: [codebase-summary.md → Project layout](../../docs/codebase-summary.md#project-layout); operator procedures: the [RUNBOOK](../../RUNBOOK.md).

## API

No global prefix; routes are served at the root. The always-current contract is **`/docs`** (Swagger UI), on by default outside production; `SWAGGER_ENABLED` overrides that either way. `/auth` is the [user-service](../user-service/README.md), the order routes the [order-service](../order-service/README.md#api), `/webhooks/payment` the [payment-service](../payment-service/README.md#api) and `/admin/inventory*` the [inventory-service](../inventory-service/README.md#api), all behind the same public origin.

**Applies to every route unless noted:** `401` without a valid access token, `403` on an `ADMIN` route without the role, `429` when throttled, `400` when a request body carries an unknown property — the global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted` — and `422` when a value passes DTO validation but breaks a domain rule (`Email`, `Slug`, `Money`). A refused state transition is a `409`, translated by the use case. Every error answers with one envelope:

```json
{ "statusCode": 409, "path": "/orders", "timestamp": "…", "requestId": "…", "traceId": "…", "message": "…" }
```

`path` is the request URL including its query string; `traceId` appears only while tracing is on. `5xx` bodies are masked to a generic message and the real error is logged; `requestId` is echoed as the `x-request-id` response header on every response, error or not. The `/health/*` probes are the exception: a `503` there carries Terminus's own body, not the envelope. Throttling skips `/health/*`, `/metrics` and `/debug/boom`.

### Catalog — `/products`, `/admin`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/products` | Public | List (paginated; optional `categorySlug`, `q`) |
| `GET` | `/products/search` | Public | Relevance search over the Elasticsearch index; eventual, about 1–2 s behind a write |
| `GET` | `/products/:idOrSlug` | Public | Detail by id or slug (`404` if unknown or not `ACTIVE`) |
| `POST` · `PATCH` `DELETE` | `/admin/categories` · `/admin/categories/:id` | `ADMIN` | Create · update, **archive** |
| `POST` · `PATCH` `DELETE` | `/admin/products` · `/admin/products/:id` | `ADMIN` | Create · update, **archive** |
| `POST` · `PATCH` `DELETE` | `/admin/products/:productId/skus` · `/admin/skus/:id` | `ADMIN` | Create a SKU under a product · update, **archive** |
| `PUT` | `/admin/skus/:skuId/price` | `ADMIN` | Set SKU price (idempotent upsert) |
| `GET` `POST` `PATCH` | `/admin/products/:productId/images` | `ADMIN` | List, attach a `READY` asset, reorder |
| `DELETE` | `/admin/products/:productId/images/:imageId` | `ADMIN` | Detach (`204`) |

`DELETE` on categories, products and SKUs is a **soft delete**: `200` with the archived entity, the row stays and disappears from the public `ACTIVE` projection. Archiving a category that still holds active products is `409`. Admin reads exist only for a product's images; catalog entities are read through the public paths.

`/products/search` is always mounted and **degrades to an empty page**: with `SEARCH_ENABLED` off, or the engine unreachable, it answers `200` with zero hits rather than a `5xx`. A client cannot distinguish "search is off" from "nothing matched". Highlight fragments are HTML-escaped apart from the `<em>` marks, so they can be rendered as HTML as they are. With `NODE_ENV=production` and `SEARCH_ENABLED=true` the api refuses to boot without `SEARCH_URL`. Reordering images requires the body to list every image on the product exactly once (`409` otherwise), so none is left at a stale position.

### Cart — `/cart` (Bearer)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/cart` | Items + subtotal, priced **live** from Catalog |
| `POST` | `/cart/items` | Add `{ skuId, quantity }`; a repeat SKU accumulates, clamped at 10 per line (`404` on an unknown SKU or one not on sale, `422` for a new SKU past 100 lines) |
| `PATCH` | `/cart/items/:skuId` | Set an absolute quantity (`404` if not in the cart, or there is no cart) |
| `DELETE` | `/cart/items/:skuId` · `/cart` | Remove one line (idempotent) · clear; neither creates a cart |

The cart is scratch space, not a transaction: prices are never snapshotted, and stock is validated only when an order is placed. An item whose product was archived after it was added stays in the cart, flagged `isActive: false`. The 100-line cap matches the most lines the inventory-service accepts in one hold, so a full cart can still check out.

### Media, health and metrics

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/admin/media/uploads` · `…/:assetId/complete` | `ADMIN` | Reserve an asset and return a presigned `PUT` plus the exact headers · confirm the bytes landed (`204`) |
| `GET` | `/health/live` · `/health/ready` | Public | Liveness · readiness (`503` if Postgres or Redis is unreachable, **or** while draining after `SIGTERM`). Never rate-limited, so a Redis outage is reported rather than masked |
| `GET` | `/metrics` | `METRICS_TOKEN` | Prometheus text format |

A rejected `complete` leaves the asset `PENDING` on purpose — the sweep already reclaims exactly that, and a second cleanup path is a second thing to get wrong. A v4 presigned signature pins `Content-Type` (the bucket refuses any other with `403` before a byte is stored) but cannot express a size *ceiling*, so `MEDIA_MAX_BYTES` is checked by `HEAD` at `complete`.

`GET /debug/boom` also exists, to prove the error pipeline end to end; it is `404` outside development and test.

### Internal routes

The order-service reads cart lines and SKU views through `/internal/v1/carts/:userId/lines` and `/internal/v1/catalog/sku-views`, so its adapters over the Cart and Product contexts are HTTP clients rather than in-process ports. They admit the order-service alone, by `INTERNAL_CALLER_TOKEN_ORDER_SERVICE`, and the gateway answers any `/internal/*` path with `404`.

## Configuration

Environment is validated **once at startup** and the process refuses to boot on anything invalid — a missing secret is a crash, not a runtime surprise. Validation is as strict as the loaders that read the values afterwards: integers must be plain decimal (`6e4` is refused rather than loaded as `6`), and booleans must be exactly `true` or `false` (`1` is refused rather than loaded as off). The root [`.env.example`](../../.env.example) is the commented reference for the api's variables (`APP_PUBLIC_URL`, `COOKIE_SECURE` and `DB_QUERY_TIMEOUT_MS` are read but not listed there yet), plus a few Compose-only ones; these are the ones without a default:

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Shared by cache, throttler, denylist and BullMQ |
| `AUTH_JWKS_URL` | The user-service's JWKS — the only key source, so without it every request is refused |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Must match what the user-service signs |
| `USER_SERVICE_INTERNAL_URL`, `INTERNAL_API_TOKEN` | Its internal API: session epochs on a Redis miss. Token min 32 chars |
| `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` | What the order-service sends on the api's `/internal/v1` routes (cart lines, SKU views). The api holds no token for any other caller; min 32 chars, and the order-service's `API_SERVICE_TOKEN` must equal it |
| `ID_SERVICE_URL` | The gateway's internal id-service listener, never a replica. Every row id is minted there, so a write answers 503 without it (`ID_SERVICE_TIMEOUT_MS`, default 2000, covers the gateway's retries) |

Groups worth knowing about, all optional with working defaults: `CATALOG_CACHE_TTL_SEC` and `CACHE_*`, `QUEUE_*`, `RETENTION_*`, `SEARCH_*`, `STORAGE_*` (S3/R2/MinIO; endpoint, bucket and the key pair are all-or-nothing), `METRICS_TOKEN`, `LOKI_URL`, `OTEL_*`, `SENTRY_DSN`, `TRUST_PROXY`, `SHUTDOWN_GRACE_PERIOD_MS`. The auth-side variables (`CSRF_SECRET`, `JWT_ES256_*`, `ARGON2_*`, the token TTLs) belong to the user-service — see its [README](../user-service/README.md) — and the stock ones (`INVENTORY_LOCK_STRATEGY`, `INVENTORY_TRY_LOCK_TIMEOUT_MS`, `INVENTORY_HOLD_SWEEP_*`) to the inventory-service ([README](../inventory-service/README.md#configuration)). The saga, mail and participant ones (`CHECKOUT_*`, `SAGA_*`, `TEMPORAL_*`, `SMTP_URL`, `INVENTORY_SERVICE_*`, `PAYMENT_SERVICE_*`) belong to the order-service ([README](../order-service/README.md#configuration)). The Stripe and webhook ones (`STRIPE_*`, `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_CAPTURE_TIMEOUT_MS`, `PAYMENT_SESSION_*`) belong to the payment-service ([README](../payment-service/README.md#configuration)); the api never reads them. Several settings of one service must agree with another's, and no process sees both, so neither can check them: `INVENTORY_TRY_LOCK_TIMEOUT_MS` below the order-service's `CHECKOUT_TRY_TIMEOUT_MS`, and the payment-service's timeouts, session floor and `ORDER_PAID_CONSUMER_ATTEMPTS` against the order-service's ([RUNBOOK → Cross-service settings](../../RUNBOOK.md#cross-service-settings)).

`MIGRATIONS_DIR` is read raw, outside Nest, by the migration CLI — the production image sets it because it ships `migrations/` without a `src/` tree.

> **`TRUST_PROXY` is required in production**, and the app refuses to boot without it. Off is correct for a direct deploy, where trusting `X-Forwarded-For` would let any client spoof its own rate-limit key. Behind a proxy, off inverts the problem: `req.ip` becomes the proxy's address and every IP-keyed throttle tier counts the proxy instead of the client. Prefer the proxy's subnet to a hop count, because then only a peer inside it is believed. On Railway the value is `fd12::/16`, the private network the gateway calls from. A hop count does not work directly behind Railway's edge, whose `X-Forwarded-For` does not end in the client. See [Known limits](../../docs/system-architecture.md#known-limits).

## Local

On the host it listens on 3000, under `pnpm dev` with the other services or alone with `pnpm start:dev` on the last package build; the root [Quick start](../../README.md#quick-start) brings up what it needs. In Compose it runs in-network behind the gateway on 8080 and publishes no port. Everything else about running it locally, its tests and its scripts: [local-development.md](../../docs/local-development.md).
