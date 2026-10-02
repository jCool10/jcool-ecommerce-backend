# Product overview

This document owns product intent, domain terminology, and business rules the code enforces but cannot state in prose. It does not restate architecture, API shapes, or setup — see [`../README.md`](../README.md) and [`./system-architecture.md`](./system-architecture.md) for those.

## Intent and non-goals

The product intent, the four invariants that drive the design, and the deliberate non-goals (multi-vendor, automatic refunds, a deployed tracing collector) are stated in [`README.md#what-this-is`](../README.md#what-this-is).

Single-store is structural, not a flag: no table carries a seller, vendor, store or tenant key, so multi-vendor would be a schema change across every context rather than a feature.

## Glossary

Each term links to the file or symbol that owns its meaning. Where the code's own name differs from the term used elsewhere (API path, event name), both are given.

- **SKU vs. variant** — the same row and the same id. The catalog table is `product_variants` (`apps/api/src/modules/product/infrastructure/catalog/schema/catalog.schema.ts`, table `productVariants`), annotated "A ProductVariant IS the sellable SKU." Cart, order and inventory all address it as `skuId`/`variantId` — the admin route `PUT /admin/inventory/:variantId` and the cart/order field `skuId` name the identical id, with no translation between them (`apps/api/src/modules/order/infrastructure/inventory-reservation.adapter.ts`, which maps `variantId: line.skuId` directly and notes "no skuId → variantId mapping" exists because none is needed). The variant row also carries a separate `sku` text column — the human-readable stock-keeping code — which is never used as an identifier anywhere.
- **Stock hold / reservation** — synonyms for one row in `reservations`, whose `status` is `HELD` (stock held, `quantityReserved` raised), `RELEASED` (hold given back — payment failed or expired), or `COMMITTED` (hold consumed for real — payment succeeded) (`apps/api/src/modules/product/domain/stock/reservation-status.ts`).
- **On-hand / reserved / available** — `quantityOnHand` and `quantityReserved` are the only persisted columns on `stock_levels`; `available` is always `on_hand − reserved`, computed on read and never stored (`apps/api/src/modules/product/infrastructure/stock/schema/stock.schema.ts`).
- **Settle / finalize** — "settle" is what happens to an order when it leaves `PENDING` for a terminal state; "finalize" is the name of the one use case that performs every settlement, `FinalizeOrderUseCase`, called by the payment webhook, the queued `payment.succeeded`/`failed` event, the reconciliation sweep, and buyer/admin cancel alike (`apps/api/src/modules/order/application/use-cases/finalize-order.use-case.ts`).
- **Order states, and which are terminal** — `DRAFT`, `PENDING`, `PAID`, `FAILED`, `EXPIRED`, `CANCELLED` (`apps/api/src/modules/order/domain/order-status.ts`). `PAID`, `FAILED`, `EXPIRED` and `CANCELLED` are `TERMINAL_STATUSES`; nothing leaves them (`apps/api/src/modules/order/domain/order-state-machine.ts`).
- **Idempotency key and its scope** — the client's `Idempotency-Key` header is scoped to `user:<userId>`, not to a route or a request body; the `(scope, key)` pair is unique, and a key replayed with a different request body is refused rather than silently reused (`apps/api/src/modules/order/interface/idempotency.interceptor.ts`, `apps/api/src/modules/order/application/ports/idempotency-store.port.ts`).
- **Outbox row** — a domain event stored as a row in `outbox`, written in the same transaction as the change it describes and unpublished until the relay ships it (`apps/api/src/shared/messaging/outbox/schema/outbox.schema.ts`).
- **Inbox claim** — a row in `inbox`, one per `(consumer, messageId)`, recorded in the same transaction as the effect it stands for; its presence is what makes a redelivered outbox message a no-op instead of a repeat (`apps/api/src/shared/messaging/inbox/schema/inbox.schema.ts`).
- **DLQ (dead-letter queue)** — `domain-events-dlq`, where a message lands once its attempt budget is exhausted; nothing consumes it automatically, and replaying it re-checks the inbox first, since a swept claim no longer means "never applied" (`apps/api/src/shared/messaging/queue/dead-letter.replay.ts`).
- **Search tombstone** — an archived product's entry in the search index, kept with `doc: null` rather than deleted, so a stale, out-of-order write can never resurrect it (`apps/api/src/modules/product/application/catalog/ports/catalog-search.port.ts`).
- **Catalog cache generation** — a single Redis integer that, when bumped, retires every catalog cache key at once in O(1); a key encodes the generation it was written under, so a miss on it is indistinguishable from a first-ever read (`apps/api/src/modules/product/infrastructure/catalog/catalog-cache.keys.ts`).
- **Session epoch** — a per-user counter the user-service bumps on logout-all or a password change; an access token carries the epoch it was issued under and is refused once that number falls behind the current one (`packages/auth-verifier/src/access-token.verifier.ts`).
- **jti denylist** — a Redis set of individually revoked access-token ids (`jti`), checked on every request alongside the session epoch; the user-service is its only writer (`packages/auth-verifier/src/access-token.verifier.ts`).
- **Refresh-token family** — every refresh token descends from one `familyId`; a reuse of any retired or revoked token in the family revokes the whole family, not just that token (`apps/user-service/src/modules/user/infrastructure/drizzle-refresh-token.repository.ts`, `revokeFamily`).
- **Id layout** — the bit layout of every id (`45 ts_ms │ 8 node │ 10 seq`), versioned by `LAYOUT_VERSION`; the epoch and widths are permanent, and the user-service's database pins the version and refuses a boot under another (`packages/id-codec/src/snowflake.codec.ts`; the pin is enforced by `apps/user-service/src/modules/user/infrastructure/identity-layout-pin.verifier.ts`).
- **Node lease and quarantine** — the id-service replica holding a node id renews its lease on a TTL; once a lease lapses, the node cannot be reclaimed until an additional quarantine window has also passed, so two replicas can never mint under the same node id during a short gap (`apps/id-service/src/lease/postgres-lease-store.ts`).
- **Media asset states** — `PENDING → READY → ATTACHED → DETACHED`, plus `SWEEPING` as a terminal claim on bytes already committed to deletion; `ATTACHED` is the only state with no expiry (`apps/api/src/modules/media/domain/asset-status.ts`).

## Business rules and constraints

Each rule below is enforced by the linked constant or file; verify there before changing the number.

- **Single store, not multi-vendor.** See [Intent and non-goals](#intent-and-non-goals) above.
- **Per-line cart quantity is clamped at 10.** `MAX_LINE_QUANTITY` in `apps/api/src/modules/cart/cart.constants.ts`, mirrored by `MAX_QUANTITY_PER_ORDER_LINE` in `apps/api/src/modules/order/order.constants.ts`, the checkout-side cap. Cart keeps its own copy rather than importing across the context boundary, so a cart line can never hold more than checkout accepts — and the two must change together.
- **A user may hold at most 3 concurrent `PENDING` orders.** `MAX_PENDING_ORDERS_PER_USER` in `apps/api/src/modules/order/order.constants.ts`, so cycling fresh idempotency keys cannot hold stock indefinitely behind orders nobody pays.
- **Currencies are integer minor units, never a float.** Enforced by the `Money` value object, which throws rather than coerces across a currency mismatch (`packages/kernel/src/money.vo.ts`).
- **An order snapshots its line's price and name at checkout.** `OrderItem.of` copies `productName` and `unitPriceMinor` once, at creation; a later Catalog price or name change never reaches a placed order (`apps/api/src/modules/order/domain/order-item.entity.ts`).
- **No automatic refunds.** A stranded successful payment on a dead order is counted, never refunded automatically (`payment_refund_owed_total`, raised from `apps/api/src/modules/payment/application/use-cases/expire-payment-session.use-case.ts`); resolving one is a person's job, detailed in [`RUNBOOK.md#a-refund-is-owed`](../RUNBOOK.md#a-refund-is-owed).
