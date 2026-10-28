# System architecture

Current boundaries and the decision ledger behind them. The topology and context-map diagrams, the bounded-context table, the layering contract and the project layout live in the root README and are not repeated here — this file adds what that map doesn't already say, and records why each durable shape was chosen over its alternatives.

## Boundaries

### Topology and data ownership

Five processes: `apps/api` (the modular monolith, five bounded contexts — [README → Architecture](../README.md#architecture)), `apps/user-service` (`/auth`, sessions, token signing), `apps/inventory-service` (stock levels and the checkout's TCC holds), `apps/id-service` (id minting, N replicas behind a leased node id) and `apps/gateway` (Caddy — public entry plus the id-service's private load balancer, [README → Project layout](../README.md#project-layout)). `packages/` holds what they share; the bodies and outcomes of every internal API are in [`@jcool/internal-contracts`](../packages/internal-contracts), imported by both ends.

The api also hosts a Temporal worker for the checkout saga ([the decision](#checkout-saga-orchestration-on-temporal-tcc-on-stock-and-payment)), polling a self-hosted Temporal server (`infra/temporal`) on the private network. Checkout and both cancel routes run through it, and answer `503` with `Retry-After` while it is down. The api's readiness leaves Temporal out, so an outage stops checkout without taking catalog, cart or auth out of rotation ([RUNBOOK → Temporal down](../RUNBOOK.md#temporal-down)).

Each service owns its own store: a Postgres database for the api, the user-service, the inventory-service and Temporal, and an etcd keyspace for the id-service. There is no foreign key between any two of them; what a restore of one does to the others is in [RUNBOOK → Backup and restore](../RUNBOOK.md#backup-and-restore). Within `apps/api` itself, the same rule holds context to context ([README → Bounded contexts](../README.md#bounded-contexts)).

| Service | Owning schema |
| --- | --- |
| api | [`shared/infrastructure/database/schema`](../apps/api/src/shared/infrastructure/database/schema) (barrel over every context's tables; `retired/` keeps the stock tables, which nothing writes, until a migration drops them) |
| user-service | [`modules/user/infrastructure/schema/user.schema.ts`](../apps/user-service/src/modules/user/infrastructure/schema/user.schema.ts) |
| inventory-service | [`modules/inventory/infrastructure/schema/stock.schema.ts`](../apps/inventory-service/src/modules/inventory/infrastructure/schema/stock.schema.ts) (`stock_levels`, `reservations`, `reservation_orders`) |
| id-service | no Postgres; an etcd keyspace, `/jcool/id-service/nodes/NNN/owner` and `floor` per node plus `initialized`, defined in [`etcd-lease-keyspace.ts`](../apps/id-service/src/lease/etcd-lease-keyspace.ts) |
| Temporal | Temporal's own schema in `temporal` and `temporal_visibility`, applied on every boot by [`infra/temporal/entrypoint.sh`](../infra/temporal/entrypoint.sh), which also creates the `jcool` namespace and the `CheckoutStep` / `CheckoutDeadlineAt` search attributes |

### Auth trust flow

The user-service signs every access token (ES256) and is the **only writer** of the shared Redis `auth:epoch:*` and `auth:denylist:*` keys; the api verifies against the user-service's JWKS and only **reads** those keys — it holds no user rows and no signing key ([README → Architecture](../README.md#architecture), [README → Security](../README.md#security)). The keys' exact names, values and writers are the user-service's own published contract ([user-service README → Published Language: Redis keys](../apps/user-service/README.md)). The shared verification logic is [`@jcool/auth-verifier`](../packages/auth-verifier), and its `/session-state` subpath holds the reader side, the Redis readers and the user-service client behind an epoch miss, which the api and the inventory-service both import.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./diagrams/auth-trust-flow-dark.svg">
  <img alt="Auth trust flow: the client logs in at the user-service and gets an ES256 token and a refresh cookie; the api checks a Bearer token against the cached JWKS, then the jti denylist and session epoch in Redis, asking the user-service for the epoch only on a Redis miss; logout-all makes the user-service raise the epoch in Redis" src="./diagrams/auth-trust-flow.svg">
</picture>

### Checkout and settlement

Order owns the checkout saga and reaches stock and payment only through participant ports ([README → Bounded contexts](../README.md#bounded-contexts)): payment's in process, and stock's through its own [`ORDER_INVENTORY_PARTICIPANT`](../apps/api/src/modules/order/application/ports/order-inventory-participant.port.ts), bound to an HTTP adapter over the inventory-service. Payment knows nothing about orders. Checkout writes the order `RESERVING`, starts the saga and waits for its Try ([`checkout-order.use-case.ts`](../apps/api/src/modules/order/application/use-cases/checkout-order.use-case.ts)); from there the saga is the only writer of order status, and every move it makes is a pure transition in [`checkout-saga.ts`](../apps/api/src/modules/order/domain/checkout-saga.ts) ([the decision](#checkout-saga-orchestration-on-temporal-tcc-on-stock-and-payment)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./diagrams/checkout-settlement-dark.svg">
  <img alt="Checkout saga: the buyer posts /orders with an Idempotency-Key; the api writes the order RESERVING in tx A and starts the CheckoutSaga workflow with Update-with-Start, waiting up to CHECKOUT_RESERVE_WAIT_MS; the saga runs the stock Try in stock's own transaction under a reservation_orders header, then tx B lands PENDING with order.placed or REJECTED, answering 201, 409 or 503 with Retry-After; /pay opens a Stripe manual-capture session and returns its URL; the buyer authorizes the card on the hosted page; the HMAC-signed webhook, or the reconcile sweep, records the authorization, whose payment.authorized event signals the saga; the saga verifies it, moves the order to CONFIRMING, commits the stock, captures and lands PAID with order.paid; at the deadline it instead expires the order, releases the stock and closes the session or voids the hold" src="./diagrams/checkout-settlement.svg">
</picture>

### How the boundaries are enforced

Error-severity rules in [`apps/api/.dependency-cruiser.cjs`](../apps/api/.dependency-cruiser.cjs) — `no-cross-context-internals`, `runtime-never-loads-contract-cases`, `domain-is-pure`, `application-no-infra`, `app-domain-telemetry-free`, `messaging-port-only-from-core`, `shared-no-module-internals`, `no-reach-outside-package` — are the mechanical form of the layering contract described in [README → Layering](../README.md#layering); the inventory-service's [own config](../apps/inventory-service/.dependency-cruiser.cjs) adds `no-local-id-generator`. Two ESLint fences add what dependency-cruiser can't express as an import-graph rule: no `await`/`async` anywhere in the mint path of [`packages/id-generator`](../packages/id-generator/eslint.config.mjs) (an awaited mint could interleave two callers onto one sequence value), and no `uuid`/`randomUUID` inside [`apps/user-service`'s user infrastructure, its id-generator service and its `scripts/`](../apps/user-service/eslint.config.mjs) or [`apps/api`'s `scripts/`](../apps/api/eslint.config.mjs) (a row id must be a snowflake id, minted through the id-service or, for a script run, on the node reserved for scripts, not a random one). The api's own seed mints on that scripts node too, through `withScriptsMintLock`.

## Decision ledger

### Modular monolith with extraction-ready contexts

- **Decision:** ship one deployable process (`apps/api`) split into bounded contexts under Clean Architecture layering, instead of a service per context from the start.
- **Why:** a single-store shop has no current need for per-context scaling or deploys, but the boundary still has to be real enough that a context can leave later as bounded work.
- **Rejected alternatives:** microservices per context from day one (operational cost with no current scaling need); an undifferentiated Nest app with no enforced boundary (cheapest short term, but the boundary erodes silently without a build gate).
- **Consequences:** the same layering rule that keeps `domain`/`application` framework-free is what let the user context, the id generator and stock leave as `apps/user-service`, `apps/id-service` and `apps/inventory-service` without moving business logic, only wiring. Stock was the first to leave from behind a saga port: the participant moved as it was, and only the order side's adapter turned into HTTP.
- **Revisit when:** a remaining context's write volume or ownership needs its own deploy cadence — payment and order still share the api's Postgres through the outbox and inbox, which an extraction has to split first ([README → Known limits](../README.md#known-limits)).

### Catalog and stock share one product module, not one aggregate

- **Status:** superseded: stock left as `apps/inventory-service`, with its own Postgres, and `modules/product` is the catalog alone. `product-aggregate-isolation` went with it. What the layout bought held: stock's code moved file for file, and nothing in the catalog had to change.
- **Decision:** `modules/product` holds the catalog group (Product with its SKUs, prices and images; Category) and the stock group (StockLevel, Reservation), laid out layer first — `<layer>/catalog/` and `<layer>/stock/` — and publishes `PRODUCT_SKU_QUERY` and `INVENTORY_PARTICIPANT` from one `application/public/`.
- **Why:** Order's checkout deals with one Product participant, which reads price and name and holds stock. Catalog edits and stock holds never need one transaction, though, so the module merges and the aggregates stay apart.
- **Rejected alternatives:** subdomain first (`product/{catalog,stock}/<layer>`), where every layering rule keyed on `modules/<context>/<layer>/` would stop matching without failing; a façade module re-exporting the old two, which merges on paper only; renaming the tables to `product_*`, which buys a migration and nothing else.
- **Consequences:** `no-cross-context-internals` no longer separates the two groups, so `product-aggregate-isolation` forbids either subdomain from importing the other in any layer. They meet only through `product.module.ts`, `application/public/` and the `variantId`, and a stock write must never bump the catalog cache generation. Table names, `catalog.*` event names, `catalog:*` cache keys, admin URLs and the `INVENTORY_LOCK_STRATEGY` / `CATALOG_CACHE_*` variables did not change.
- **Revisit when:** stock needs its own database or a reservation has to call an external warehouse system. The original trigger, "the hold leaves checkout's local transaction and becomes a saga step, so `PRODUCT_STOCK_RESERVATION` loses the caller's `tx` and turns into a command/reply contract", is superseded by [Checkout saga](#checkout-saga-orchestration-on-temporal-tcc-on-stock-and-payment): the hold is already a TCC step behind `INVENTORY_PARTICIPANT`, which takes no caller transaction.

### Transactional outbox and inbox instead of dual-write

- **Decision:** any write that must reach another system (BullMQ, another context, the search engine) appends an outbox row in the same transaction as the change; a consumer claims the message in an inbox table and applies its effect inside that same claim transaction.
- **Why:** no transaction spans Postgres and a queue or an external engine, so the only place a "committed but not yet delivered" state can survive a crash is a row that committed with the change itself.
- **Rejected alternatives:** dual-write with a post-commit call (silently drops on a crash between the two — the design [search index consistency](#search-index-consistency) replaced); 2PC/XA (BullMQ and Elasticsearch aren't XA resources); a saga with compensation (nothing to compensate — the downstream should converge, not be undone).
- **Consequences:** delivery is at-least-once, effects are exactly-once only because the inbox claim and the effect commit together ([README → distributed systems](../README.md#distributed-systems)).
- **Revisit when:** outbox-polling throughput becomes the bottleneck — the next step is CDC via a Debezium outbox router, not a rewrite of the handlers.

### FinalizeOrderUseCase: one row lock, no distributed lock

- **Status:** superseded by [Checkout saga](#checkout-saga-orchestration-on-temporal-tcc-on-stock-and-payment). The use case and every path into it are gone. What carried over: no distributed lock, and a status guard under the order row lock, now in the saga's `applyOrderChange`.
- **Decision:** every path that settles an order (webhook, queue consumer, reconcile sweep, expired-hold sweep, cancel) funnels through one `FinalizeOrderUseCase`, guarded by `SELECT … FOR UPDATE` on the order row plus a terminal-status check — never a distributed lock.
- **Why:** settlement has to commit atomically with a caller's own transaction, a consumer's inbox claim in particular; an external lock (Redis, ZooKeeper) can be released without that commit ever happening, which a row lock inside the same transaction cannot.
- **Rejected alternatives:** a distributed lock service; per-path settlement logic, which would duplicate the terminal guard once per caller and risk one that forgets it.
- **Consequences:** `execute` can run standalone or `join` a caller's transaction; no network I/O is allowed inside it, so a gateway call must be resolved before entry (`finalize-order.use-case.ts`, since deleted).
- **Revisit when:** settlement needs to span more than one Postgres instance — that would need a saga step, the same shape the api/user-service split already uses for `order.paid`.

### Two inventory lock strategies behind one port

- **Decision:** `StockRepositoryPort` exposes both a pessimistic (`SELECT … FOR UPDATE`) and an optimistic (version CAS, bounded retry) reservation path, picked at runtime by the inventory-service's `INVENTORY_LOCK_STRATEGY`, both inside the Try's own transaction.
- **Why:** which one wins is a function of contention shape (a hot SKU vs. broad low-contention traffic) — an operational measurement, not an architectural one ([README → Concurrency and consistency](../README.md#concurrency-and-consistency), `test/load/` → `load:sku-contention`).
- **Rejected alternatives:** committing to a single strategy repo-wide (forecloses the measurement); a distributed lock across replicas (unnecessary — both strategies already run inside the caller's own transaction).
- **Consequences:** the optimistic path's idempotency check is not lock-guarded by itself ([`stock-repository.port.ts`](../apps/inventory-service/src/modules/inventory/application/ports/stock-repository.port.ts)); what makes a repeated Try on one order safe under either strategy is the `reservation_orders` header the Try takes before any stock row.
- **Revisit when:** `load:sku-contention` shows one strategy dominating every measured shape, making the switch dead weight.

### Checkout saga: orchestration on Temporal, TCC on stock and payment

- **Status:** live. Checkout and both cancel routes run on the saga, and `/pay` opens the payment participant's manual-capture session; the single-transaction settlement it replaced is deleted, together with its webhook settlement, stale-order reconcile and reservation-expiry sweep.
- **Decision:** checkout becomes a saga orchestrated by the order context, with its state in a self-hosted Temporal workflow (`CheckoutSaga`). Stock and payment are TCC participants: stock holds, then commits or releases; payment authorizes through Stripe manual capture, then captures or voids. Capture is the one pivot and runs only after stock has committed. What follows the saga (mail, search) stays choreographed over the outbox.
- **Why:** order, stock and payment are headed for separate services, which ends checkout's single transaction. With three participants, money and four compensation paths, the flow and its compensations need one owner that can be read, tested and observed. A TCC hold keeps stock that may still be undone out of other buyers' reach, and manual capture turns "paid but out of stock" from a manual refund into a free void.
- **Rejected alternatives:** keeping settlement in one Postgres transaction under one row lock ([the previous decision](#finalizeorderusecase-one-row-lock-no-distributed-lock); it cannot survive order, stock and payment leaving one database, and it let a buyer pay for stock a cancel had already released); choreography for checkout itself (compensation would be spread across handlers in three services with no single owner); plain saga compensation on payment (the inverse is a refund, which costs money and can fail); 2PC/XA (Stripe is not an XA resource); a hand-rolled saga table and runner (Temporal already gives durable timers, retries and one writer per saga); Temporal Cloud (the server stays on the private network).
- **Consequences (checkout):** Temporal is a dependency of checkout. With it down, `POST /orders` and cancel answer `503` with `Retry-After` (`CHECKOUT_RETRY_AFTER_SEC`) and catalog and cart keep serving; a buyer who retries with a fresh key each time leaves a hidden `RESERVING` order per attempt, and those count against the in-flight cap, so the fourth attempt answers `409` until the reaper rejects them once Temporal is back. Checkout commits the order `RESERVING` (tx A), the saga's Try holds stock in stock's own transaction, and tx B writes `PENDING` with `order.placed`, or `REJECTED`. A refused Try (out of stock, contended, conflict) answers `409` and a Try without an answer `503`; either way the order is `REJECTED`, hidden from the buyer (404, never listed) and swept after `RETENTION_REJECTED_ORDER_DAYS`. If tx B cannot commit (the outbox or the id-service is down), the buyer gets `503`, the order stays `RESERVING` with its hold, and tx B retries until it commits; a retry under the same key then replays the placed order. A `RESERVING` order whose start never reached Temporal is handed back by the reaper. The saga is the only writer of order status, through `applyTryResult` and `applyOrderChange`; payment never reads or writes an order.
- **Consequences (stock):** stock lives in `apps/inventory-service`, which publishes [`INVENTORY_PARTICIPANT`](../apps/inventory-service/src/modules/inventory/application/public/inventory-participant.port.ts) with `tryReserve`, `commit`, `release`, `restock` and a lock-free batch `statusOf`, and serves it as `POST /internal/v1/reservations/:orderId/{try,commit,release,restock}` and `/status`. The order side calls it through an HTTP adapter whose Try is a single attempt, aborted when the local activity's `scheduleToCloseTimeout` runs out, and whose commands are retried by their activities until they land; a breaker named `inventory-service` opens on the service's own faults only, never on a `409` or `4xx`, nor on the `503` coded `LOCK_BUDGET_EXHAUSTED` that answers rows held past the lock budget, so one hot SKU cannot fail checkout fast for every other. The in-memory stub the api's e2e suites run against, the in-process participant and the real service all pass the same case table, `INVENTORY_CONTRACT_CASES`. Every command on an order goes through one `reservation_orders` header, whose row lock serializes commands on that order. A release that arrives before any Try writes `FENCED`, so a late Try answers `CONFLICT` instead of hanging a hold; a repeated Try on a held order answers `RESERVED` and a repeated commit, release or restock answers `IDEMPOTENT`. A Try spends one wall-clock budget, `INVENTORY_TRY_LOCK_TIMEOUT_MS`, across all of its lock waits and gives up leaving neither header nor hold. That budget must stay below the api's `CHECKOUT_TRY_TIMEOUT_MS`, or the saga gives up on Tries the service would still have answered; no process sees both, so the rule lives in the RUNBOOK and both `.env.example` files. A `HELD` header past its `hold_until` is released by its own sweep, which skips headers another transaction holds. `tcc_branch_total` counts every command by participant, op and outcome.
- **Consequences (payment):** payment publishes [`PAYMENT_PARTICIPANT`](../apps/api/src/modules/payment/application/public/payment-participant.port.ts) with `openSession`, `capture`, `cancel` and a lock-free batch `statusOf`, fenced per order by a `payment_orders` header that is always locked before the order's `payments` rows. No transaction is held across a Stripe call: an open inserts its payment only if the header is still `OPEN` once the session exists, and a cancel flips the header first, then expires or voids, then records what Stripe did, so a racing open always loses. A hold becomes `payment.authorized` once per order, from the webhook, the reconcile sweep or an open's probe; a hold on any attempt but the current one is voided instead. Capture and void keys are `{op}:{paymentId}:{gen}`, and `gen` moves only after a 5xx the adapter proved Stripe did not apply, because Stripe replays a stored 5xx for its key. Capture and void run under their own breaker, `payment_capture`, whose timeout fits a slow call and its read-back, so a slow capture never opens the breaker `/pay` and the webhook depend on. A webhook for a session no header owns is recorded `SKIPPED`; if it reports cleared money, `payment_refund_owed_total{source="webhook_direct"}` counts it, since nothing will ever capture or void it. `NODE_ENV=production` refuses to boot without `STRIPE_SECRET_KEY` and `STRIPE_SUCCESS_URL`.
- **Revisit when:** a payment method without manual capture has to be supported, since payment then needs a refund as compensation and capture stops being the only pivot; or running Temporal costs more than the saga it carries.

### Ids minted by a separate id-service, not in process

- **Decision:** every row id in every service is minted by calling `apps/id-service` over the gateway's internal listener, rather than by a generator embedded in each process.
- **Why:** the layout carries no random bits, so uniqueness rests entirely on one node id being held by exactly one process at a time; two api replicas both defaulting to node 0 during a rolling deploy would collide with no random bits to save them ([README → Known limits](../README.md#known-limits)). Leasing that safely needs a coordination point shared by every writer — the api and the user-service both mint through it — not duplicated lease/fencing machinery in each.
- **Rejected alternatives:** an in-process leased generator per app (duplicates the lease and clock fencing this now centralizes); the previous 128-bit UUIDv8 with random bits (dropped for a 63-bit integer that fits a Postgres `bigint`).
- **Consequences:** every write depends on the id-service's reachability — a write answers `503` rather than mint locally when no id is available ([README → Known limits](../README.md#known-limits)).
- **Revisit when:** the 254-node lease pool or the 1024-id-per-node-millisecond ceiling becomes the binding constraint — already documented as a data migration behind a `LAYOUT_VERSION` bump, not a service-topology change.

### Node lease on etcd

- **Decision:** the id-service's node-id lease lives in a single-member etcd (`id-etcd`, private network only, no auth or TLS) instead of its own Postgres. Each node has an owner key, attached to an etcd lease, and a floor key, a timestamp in the id domain; a claim is one transaction guarded by owner-absent and floor-unchanged that raises the floor to the ceiling `max(now, floor) + TTL`, and no id is stamped past the ceiling. The keyspace is defined in [`etcd-lease-keyspace.ts`](../apps/id-service/src/lease/etcd-lease-keyspace.ts), the protocol in [`etcd-lease-store.ts`](../apps/id-service/src/lease/etcd-lease-store.ts) and the [id-service README](../apps/id-service/README.md#the-node-lease).
- **Why:** a lease is etcd's own primitive: the server drops an abandoned owner when its lease's TTL runs out, and the lease id it grants lets a replica recognise a claim whose commit it never saw, so re-adopting no longer trusts a holder name to be unique per process. Revision-guarded transactions are the compare-and-set for claim, renew and release. etcd has no clock a client can read, so the lease rests on a floor written in the ids' own domain rather than on the store's time. The next holder starts above the previous ceiling, which covers whatever a crashed holder minted after its last renew, so the quarantine window is gone: a released node is free at once and a crashed holder's node frees when etcd expires its lease, at most the TTL later. The id-service no longer needs a database, migrations or a schema of its own.
- **Rejected alternatives:** keeping the dedicated Postgres, with its migrations, its quarantine window and a re-adopt keyed on the holder name; a three-member etcd cluster, whose availability the replicas' fence already covers for a restart or a redeploy of the single member.
- **Consequences:** an empty keyspace carries no floors, so replicas refuse to claim until [`lift-floors-cli.ts`](../apps/id-service/src/lease/lift-floors-cli.ts) lifts every floor to the clock and writes the `initialized` marker; it runs as the pre-deploy step with `--if-uninitialized`. Losing the keyspace is recovered the same way and a snapshot is never restored into it ([RUNBOOK → The keyspace is lost](../RUNBOOK.md#the-keyspace-is-lost)). The cut-over from Postgres was manual and cost about ten minutes of write downtime ([RUNBOOK → Cut over from Postgres](../RUNBOOK.md#cut-over-from-postgres)); Postgres-era and etcd-era replicas must never run together, which a rollback has to respect too ([RUNBOOK → Roll back the cut-over](../RUNBOOK.md#roll-back-the-cut-over)).
- **Revisit when:** a single etcd member's availability becomes the limit on writes, since with etcd down the replicas stop minting once their fence is reached.

### 63-bit snowflake layout: `45 ts_ms │ 8 node │ 10 seq`

- **Decision:** every id is `45 ts_ms │ 8 node │ 10 seq` over an epoch of 2026-01-01, with no routing field. It superseded layout 1 (`41 ts_ms │ 12 bucket │ 5 node │ 5 seq`), whose 12-bit bucket was an HMAC of the owner's normalized email so that a future shard split could route from the id alone.
- **Why:** nothing ever read the bucket, and it cost the most: 41 timestamp bits ran out in about 70 years, and 5 sequence bits and 5 node bits capped a node at 32 ids per millisecond and the pool at 30 leases. Dropping it let the timestamp reach year 3140 and gave the rest to `node` (254 leasable) and `seq` (1024 per node-millisecond). It also removed a permanent secret and the email-derived coupling between the id and the account.
- **Rejected alternatives:** `45 ts_ms │ 5 node │ 13 seq` (the node ceiling stays at 32 leases, which is the failure risk when each restart may take a new lease); keeping any routing field in the id (a shard split is speculative, and a directory or a hash of the id can serve one when it is real).
- **Consequences:** a future shard split needs a lookup or directory, not a bit field. The layout version is pinned in the user-service's database on first boot and checked on every later boot, so changing the epoch or a field width is a one-way door that ships as a reset, not a config change ([RUNBOOK → The id layout is permanent](../RUNBOOK.md#the-id-layout-is-permanent), [Changing the id layout](../RUNBOOK.md#changing-the-id-layout)). The rollout took no backward compatibility: layout-1 databases were reset.
- **Revisit when:** a shard split actually ships, or 254 nodes or 1024 ids per node-millisecond stops being enough.

### User-service extraction: ES256 + JWKS, a stateless api verifier, Redis epoch/denylist

- **Decision:** pull `/auth`, the user tables and token signing into `apps/user-service`; the api keeps no user rows and verifies ES256 tokens against the user-service's JWKS, with revocation carried in a shared Redis epoch and denylist rather than a per-request call to the user-service.
- **Why:** a stateless, asymmetric verification path lets the api revoke instantly (denylist, epoch) without holding a shared signing secret or calling the user-service on every request.
- **Rejected alternatives:** the prior HS256 shared-secret verification, retired once JWKS-based verification was live and soaked — a shared secret would mean the api holds what a signing key guards; a synchronous per-request call to the user-service for every verification, which the epoch/denylist keys in Redis exist to avoid.
- **Consequences:** the api refuses to boot without `AUTH_JWKS_URL`, `JWT_ISSUER`/`JWT_AUDIENCE` matching what the user-service signs, and `USER_SERVICE_INTERNAL_URL` for the epoch-miss path ([RUNBOOK → The api depends on the user-service](../RUNBOOK.md#the-api-depends-on-the-user-service)).
- **Revisit when:** a verifier needs something Redis cannot carry. The inventory-service is the second verifier and reuses the path whole: `@jcool/auth-verifier` for the check, its `/session-state` subpath for the readers, and its own caller token for the epoch-miss call.

### Caddy gateway as the public entry, and `TRUST_PROXY`

- **Decision:** all public traffic lands on `apps/gateway` (Caddy), which routes `/auth` to the user-service, `/admin/inventory*` to the inventory-service and everything else to the api unchanged, and tells each of them the real client address.
- **Why:** directly behind Railway's edge, no `TRUST_PROXY` value can name the client — the edge's own `X-Forwarded-For` does not end in the client, so a hop-count setting cannot work ([README → Configuration](../README.md#configuration)). A gateway the app trusts by private-network CIDR, not by hop count, is what makes an IP-keyed throttle mean anything.
- **Rejected alternatives:** trusting `X-Forwarded-For` directly from the public edge (spoofable by any client — the gap this design closes, [README → Known limits](../README.md#known-limits)); a hop-count `TRUST_PROXY` value (provably wrong on Railway's topology, per the same section).
- **Consequences:** production refuses to boot without `TRUST_PROXY` set; moving the public domain onto the gateway is a manual, one-time cutover, not a code change ([RUNBOOK → Put the gateway in front of the api](../RUNBOOK.md#put-the-gateway-in-front-of-the-api)).
- **Revisit when:** the edge in front of it can name the client reliably by itself. Routing `/auth` and `/admin/inventory*` still needs a router either way, and the gateway refuses to start without `INVENTORY_UPSTREAM` rather than fall back to the api, which would serve stock from tables it no longer writes.

### Internal APIs admit callers by a token each

- **Decision:** an internal API names its callers. A callee reads `INTERNAL_CALLER_TOKEN_<CALLER>` (and `_PREVIOUS`, for a rotation) per caller, and each route declares which callers it admits; [`CallerTokenGuard`](../packages/platform/src/internal-api/caller-token.guard.ts) in `@jcool/platform/internal-api` matches the bearer in constant time against every configured token and answers `401` for no match and `403` for a caller the route does not list. The user-service admits the api on every internal route and the inventory-service on `sessions/:userId/epoch` alone (the api's caller token there is still `INTERNAL_API_TOKEN`); the inventory-service admits the api on `/internal/v1/reservations`.
- **Why:** one shared `INTERNAL_API_TOKEN` stops naming anyone once a second service holds it: a leak from the inventory-service would open the user-service's buyer addresses and cut-over digest, and a rotation would have to move every caller at once.
- **Rejected alternatives:** the shared token (above); mTLS on the private network (Railway's private network gives no certificates, and a CA is a service of its own to run); signed service JWTs (a signing key per service and a JWKS per callee, for the same "which caller is this" answer).
- **Consequences:** each caller's token is generated, rotated and fingerprinted on its own ([RUNBOOK → Per-caller internal tokens](../RUNBOOK.md#per-caller-internal-tokens)). Every caller token is optional at validation, and a callee refuses to boot with none or with two callers sharing one, so a later caller is added, and a retired one removed, while the callee runs the code before it. A token sits in both places by value: the callee's `INTERNAL_CALLER_TOKEN_<CALLER>` and the caller's `*_SERVICE_TOKEN`.
- **Revisit when:** callers outnumber what a hand-run rotation can keep straight, or the platform starts issuing workload identity.

### Order mail at-most-once; auth mail synchronous and outside the outbox

- **Status:** still holds under the [checkout saga](#checkout-saga-orchestration-on-temporal-tcc-on-stock-and-payment): the mail rides `order.paid`, which the saga's `PAID` change appends. The "settlement transaction" named below is now that change's transaction.
- **Decision:** order confirmation mail is applied once in the database and attempted at most once outside it (failure is counted, not retried). Auth mail (verification, password reset) sends synchronously, outside the outbox entirely.
- **Why:** a retried order mail under a breaker timeout could resend up to eight times for one order — worse than one lost mail. Auth mail carries a raw redeemable token that only exists unhashed at send time; an outbox payload would persist that token in Postgres in plaintext ([README → Known limits](../README.md#known-limits)).
- **Rejected alternatives:** SMTP inside the settlement transaction (a slow or dead relay would then block or roll back order settlement); an outboxed auth-mail payload (would leak the raw token to disk).
- **Consequences:** `mail_send_failures_total` is the only signal a confirmation mail failed; there is no automatic recovery path today.
- **Revisit when:** the at-most-once tolerance changes — README already names the fix as a separate `mail_outbox` table, not moving SMTP back inside the transaction.

### Migrations as a release command

- **Decision:** schema migrations run as Railway's `preDeployCommand`, separate from application bootstrap, gating the traffic switch rather than running inside the app's own startup.
- **Why:** a failed migration then stops the rollout instead of crash-looping the new version and taking down the previous one that was still serving traffic ([README → Operations](../README.md#operations)).
- **Rejected alternatives:** running migrations at app boot (a failed migration crash-loops the new deployment and can take the healthy previous version down with it under some rollout strategies).
- **Consequences:** an out-of-band migration run is a documented manual step for the cases the release path doesn't cover ([RUNBOOK → Apply migrations out of band](../RUNBOOK.md#apply-migrations-out-of-band)).
- **Revisit when:** the release pipeline itself changes providers or deploy mechanics; the constraint (migrate before traffic, gate on failure) should survive that move.

### Logs to Loki, no deployed trace backend

- **Decision:** structured logs ship to a self-hosted Loki on Railway; OpenTelemetry traces are wired in the code but no trace collector is deployed there.
- **Why:** a hosted trace backend is an operational commitment this project doesn't need to make its point; logs plus a `traceId` field carried on every line already answer "what happened to this request across services" ([README → Observability](../README.md#observability)).
- **Rejected alternatives:** deploying Jaeger or an OTel Collector to Railway alongside Prometheus, Loki and Grafana (real infrastructure cost for a capability the log correlation already covers).
- **Consequences:** Grafana links a `traceId` to that trace's log lines across services instead of rendering a span tree; there is no deployed way to see span-level timing in production ([README → Known limits](../README.md#known-limits)).
- **Revisit when:** a production investigation needs span-level timing across services that log correlation cannot answer — the local `docker compose --profile observability` stack (Collector, Prometheus, Grafana, Jaeger) is the shape to deploy at that point.

### Search index consistency

`/products/search` reads an Elasticsearch index. The index is derived data: Postgres is the only source of truth for the catalog, and the index can always be rebuilt from it. No transaction spans Postgres and the engine, so any design has to answer one question: what brings the index back into line after a write that committed in Postgres but never reached the engine?

The previous design (Meilisearch) called the engine right after the commit and logged the failure. A crash, a deploy or an engine outage between the two left the index wrong until someone ran a full reindex, and nothing said which documents were stale.

What the design had to hold, in order of weight:

- A committed catalog write always reaches the index, with no manual step while the engine comes back within the retry horizon.
- Deliveries in any order, repeated or late, leave the newest state in the index.
- An archived product never reappears in search.
- A full rebuild never leaves search empty.
- Catalog work never delays order and payment work.

**Options considered:**

| Option | What it guarantees | Verdict |
| --- | --- | --- |
| Naive dual-write (commit, then call the engine) | Nothing on failure: a crash or an engine error between the two loses the update silently | Rejected — the design being replaced |
| Index first, then commit | The engine can hold a change Postgres rolled back, serving a product that does not exist | Rejected — inverts the source of truth |
| 2PC / XA | Atomic commit across both stores, in theory | Rejected — Elasticsearch is not an XA resource, and a coordinator would make every catalog write wait on search availability |
| Saga with compensation | Each step undone on failure | Rejected — there is nothing to compensate; the index should follow Postgres, not veto it |
| Transactional outbox | The event commits with the write or not at all; delivery is at-least-once and retried | **Chosen** — the outbox, relay, queue, retry ladder and DLQ already run for orders and payments |
| CDC (Debezium on the WAL) | The same guarantee, read from the log instead of polled | Rejected for now — needs Kafka Connect and a replication slot, operational weight a single-store project does not need. Next step if outbox polling becomes the bottleneck |
| Log first / listen to yourself | One ordered log feeds Postgres and the index alike | Rejected — moves the source of truth off Postgres and rewrites every catalog write path |
| Periodic reconciliation only | Eventual repair on a timer | Rejected as the primary path — staleness is bounded by the sweep interval, and each sweep scans the whole catalog. The full rebuild covers the rare case it would serve |

**Decision:** a transactional outbox with thin events, applied through versioned writes the engine itself orders.

- **Version in the row.** Every write that changes what a product document shows increments `products.search_version` and appends a `catalog.product.changed` outbox row in the same transaction ([`drizzle-catalog-admin.repository.ts`](../apps/api/src/modules/product/infrastructure/catalog/drizzle-catalog-admin.repository.ts)).
- **Thin events, re-read at consume time.** The event carries only the product id. The worker reads the product as it is now and writes it with `version_type: external`, so the engine refuses any version at or below the one it holds — a late, repeated or reordered delivery is a no-op instead of a regression ([`product-search-sync.service.ts`](../apps/api/src/modules/product/application/catalog/services/product-search-sync.service.ts), [`elasticsearch-catalog-search.adapter.ts`](../apps/api/src/modules/product/infrastructure/catalog/search/elasticsearch-catalog-search.adapter.ts)).
- **Tombstones, not deletes.** A product that leaves the public projection is stored as a versioned document search never matches, so a stale write arriving after an archive cannot recreate it.
- **Category renames fan out in the worker.** A rename appends one `catalog.category.renamed` row; the worker bumps and rewrites the category's products in pages, so the rename transaction stays small whatever the category holds.
- **Rebuilds go through a second alias.** `search:reindex` fills a fresh index behind a rebuild alias while live writes reach both indices, then swaps the `products` alias atomically; the rebuild alias doubles as the lock ([`reindex-runner.ts`](../apps/api/src/modules/product/infrastructure/catalog/search/reindex-runner.ts)).
- **Catalog jobs yield.** They carry a lower BullMQ priority, so a burst of catalog events queues behind order and payment work, and they share the long retry ladder with `order.paid` and `payment.authorized` through the `ORDER_PAID_CONSUMER_*` keys, read in [`configuration.ts`](../apps/api/src/shared/config/configuration.ts) and applied per event by `jobOptionsFor` in [`queue.constants.ts`](../apps/api/src/shared/messaging/queue/queue.constants.ts). Every engine call runs behind one of two circuit breakers, one for reads and one for writes, kept separate because the engine can refuse writes while still answering queries.

**Invariants:**

- A catalog write committed means its event committed.
- The engine never accepts an older version of a document than the one it holds.
- An archived product never reappears in search, whatever arrives late, including during a rebuild.

**Operational consequences:**

- A database restore rewinds `products.search_version`. The engine then holds versions the database no longer reaches and refuses every later write to those products until they catch up — a rebuild must follow any restore ([RUNBOOK → Rebuild the search index](../RUNBOOK.md#rebuild-the-search-index)).
- The retry ladder is shared with `order.paid` and `payment.authorized`: tuning `ORDER_PAID_CONSUMER_*` moves all of them. An event still failing past the horizon (about 33 minutes) lands in the DLQ, and replaying a `catalog.*` message is always safe, `--force` included, because the handler re-reads and re-applies rather than replaying a stored effect ([RUNBOOK → Replay the dead-letter queue](../RUNBOOK.md#replay-the-dead-letter-queue)).
- Search lags writes by the relay's poll interval plus the engine's refresh interval, about 1 to 2 seconds. Search is not read-your-writes.
- Elasticsearch costs memory — see [RUNBOOK → Deploy Elasticsearch](../RUNBOOK.md#deploy-elasticsearch) for the measured budget.
- The index holds tombstones for every product outside the public projection; the rebuild writes them too.

**Revisit when:**

- Several consumers of catalog changes appear, or write volume makes polling the outbox the bottleneck — move to CDC with the Debezium outbox router; the handlers and the event envelope survive, only the relay changes.
- Catalog jobs start delaying other work, or the reverse — give catalog events a queue and a worker of their own instead of a priority on the shared one.

Replaces the Meilisearch adapter and its best-effort post-commit sync.
