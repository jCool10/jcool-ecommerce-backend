# Runbook

Procedures an operator needs that the code cannot express on its own. Everything here is a manual action with consequences — nothing in this file runs on a schedule.

Conventions used below:

- **local** — a developer machine with the repo, `pnpm install` and `pnpm dev:link-env` done, and `.env` pointing at the target. Arguments go without `--` (`pnpm queue:replay-dlq --queue api-events --apply`): pnpm forwards a literal `--` to the command.
- **container** — a shell inside the deployed image (`railway ssh --service "$RAILWAY_SERVICE"`), where `dist/` exists and `devDependencies` (including `tsx`) do **not**.

---

## Contents

- [The id layout is permanent](#the-id-layout-is-permanent)
- [Changing the id layout](#changing-the-id-layout)
- [Backup and restore](#backup-and-restore)
- [Rebuild the search index](#rebuild-the-search-index)
- [Reconcile the bucket against `media_assets`](#reconcile-the-bucket-against-media_assets)
- [Outbox relay is not draining](#outbox-relay-is-not-draining)
- [Replay the dead-letter queue](#replay-the-dead-letter-queue)
- [Retention sweeps](#retention-sweeps)
- [A refund is owed](#a-refund-is-owed)
- [Apply migrations out of band](#apply-migrations-out-of-band)
- [Change Railway service config](#change-railway-service-config)
- [Enable Stripe test mode on Railway](#enable-stripe-test-mode-on-railway)
- [Freeze checkout](#freeze-checkout)
- [Deploy the monitoring stack](#deploy-the-monitoring-stack)
- [Logs in Loki](#logs-in-loki)
- [Deploy Elasticsearch](#deploy-elasticsearch)
- [The id-service's etcd](#the-id-services-etcd)
- [Operate Temporal](#operate-temporal)
- [The checkout saga](#the-checkout-saga)
  - [Settle a payment by hand](#settle-a-payment-by-hand)
  - [Its alerts](#its-alerts), one subsection each
  - [Retention and the checker window](#retention-and-the-checker-window)
  - [`CHECKOUT_INVARIANT_NOT_BEFORE`](#checkout_invariant_not_before)
- [Temporal down](#temporal-down)
- [Cut over checkout to the saga](#cut-over-checkout-to-the-saga)
- [Put the gateway in front of the api](#put-the-gateway-in-front-of-the-api)
- [The user-service](#the-user-service)
- [The api depends on the user-service](#the-api-depends-on-the-user-service)
- [The inventory-service](#the-inventory-service)
- [The payment-service](#the-payment-service)
- [The order-service](#the-order-service)
- [Cross-service settings](#cross-service-settings)
- [Per-caller internal tokens](#per-caller-internal-tokens)
- [Cut stock over to the inventory-service](#cut-stock-over-to-the-inventory-service)
- [Cut payments over to the payment-service](#cut-payments-over-to-the-payment-service)
- [Cut checkout over to the order-service](#cut-checkout-over-to-the-order-service)
- [Standing exceptions](#standing-exceptions)

---

## The id layout is permanent

**This is not a policy, it is a one-way door.**

An id is a 63-bit integer laid out `45 ts_ms │ 8 node │ 10 seq` over an epoch of `2026-01-01T00:00:00Z` (`packages/id-codec/src/snowflake.codec.ts`). The epoch and the field widths are permanent: moving either is silent, since a new epoch makes every stored id decode to a different timestamp and a new width makes it decode into different fields, and ids minted under a wider timestamp sort below the ones already stored.

The user-service's database pins `LAYOUT_VERSION` in `identity_key_pin.layout_version`, and `IdentityLayoutPinVerifier` (`apps/user-service/src/modules/user/infrastructure/identity-layout-pin.verifier.ts`) compares it on every boot. It **fails open** if the database is unreachable (no id is minted while it is down) and **fails closed** only on a disagreement actually read back. The api and the id-service hold no pin.

The pin is **written** only when it is absent, `IDENTITY_PIN_BOOTSTRAP=true`, and the `users` table is empty: rows minted before any pin carry a layout this boot cannot read back, and pinning the running one would make a guess the reference every later boot is held to. The boot that writes it logs:

```
id layout pinned — no layout was pinned here before
```

A boot asked to write the pin that reads an empty `users` table but cannot finish the write **refuses to start** with `id layout pin not written: …`, and the next boot retries: once a first user lands unpinned, no later boot can pin. Leave `IDENTITY_PIN_BOOTSTRAP` unset against a database that already holds the pin.

### If a boot is refused

```
The id layout does not match the one this database was built with (pinned X, current Y)
```

There are exactly two correct responses:

- **Restore the original build**, the one whose `LAYOUT_VERSION` is the pinned one, and redeploy.
- **Reset the database**, if and only if it holds nothing worth keeping.

There is no third option. Do not edit or delete the pin row to make the message go away: it is the only evidence of which layout the existing ids were minted under, and nothing can rebuild it. The same holds for the api's database and the id-service's etcd keyspace, which carry no pin but hold ids and node floors from the same layout.

---

## Changing the id layout

A layout change bumps `LAYOUT_VERSION` and rewrites the meaning of every stored id. The codec spec pins the layout beside `LAYOUT_VERSION`, so the change fails CI until that expectation is rewritten. Nothing maps old ids to new ones, so a change ships as a reset, not a migration. Layout 2 replaced layout 1 (`41 ts_ms │ 12 bucket │ 5 node │ 5 seq`) this way: it dropped the email-derived routing bucket, widened the timestamp to 45 bits, and gave the freed bits to `node` and `seq`. The reasoning is in the [decision record](./docs/system-architecture.md#63-bit-snowflake-layout-45-ts_ms--8-node--10-seq).

CD deploys one service at a time (id-service → api → gateway → user-service) and runs each one's migrations in its pre-deploy step, so everything below up to the merge happens while the services are stopped. The layout-2 rollout, in order:

1. **Stop** the api, the user-service and the id-service, and keep them stopped for longer than the user-service's `JWT_ACCESS_TTL`, so no access token naming a layout-1 user id is still live when they return.
2. **Close open checkouts.** Every `PENDING` payment (on `payment-postgres`: `SELECT id, order_id, provider_session_id FROM payments WHERE status = 'PENDING'`) has a hosted checkout page that can still take money for an order the reset deletes. Expire each session in the payment gateway's dashboard and refund any that already read `paid`, as in [A refund is owed](#a-refund-is-owed).
3. **Back up, then reset** the api's and the user-service's databases to empty ([Backup and restore](#backup-and-restore)); a layout-2 build cannot serve the dumps. The api's `0028_snowflake_layout_v2_id_floor.sql` and the user-service's `0003_snowflake_layout_v2_pin_and_id_floor.sql` refuse to run while any of their tables holds a row (`id layout 2 needs a reset database: table … is not empty`), so a database that was missed stops the deploy at its pre-deploy step.
4. **Flush the shared Redis** (`railway connect <redis service>`, then `FLUSHALL`). Its queued and dead-lettered jobs, its `auth:epoch:*` and `auth:denylist:*` keys and its cached catalog pages all name layout-1 ids, and a `queue:replay-dlq --queue <queue> --apply` would put those jobs back on the queues.
5. **Remove `IDENTITY_BUCKET_KEY`** now: `.railway/railway.ts` no longer lists it, so CD would otherwise hold the deploy for a [destructive review](#review-a-destructive-change). From this change's checkout, run `railway config plan` (the only destroy must be that variable), then `railway config apply --confirm-destructive` ([Change Railway service config](#change-railway-service-config)). Keep its value with the step-3 dumps: a rollback needs it back.
6. **Set `IDENTITY_PIN_BOOTSTRAP=true`** on the user-service, so its first boot pins the empty database at layout 2.
7. **Merge.** The id-service's `0004_widen_node_pool.sql` widens the leasable node pool to `1..254`; `0028` and `0003` move every `ck_<table>_<column>_routable` floor to `>= 262144` (2^18), and `0003` drops the old pin fingerprint.
8. **Check the pin** before anything writes a user: the user-service logs `id layout pinned — no layout was pinned here before`, and `SELECT layout_version FROM identity_key_pin` returns `2`. Then unset `IDENTITY_PIN_BOOTSTRAP`.
9. **Re-seed** (`pnpm db:seed`), only once the pin is there: a seed run that inserts users first leaves the database unpinnable. Then [reconcile the media bucket](#reconcile-the-bucket-against-media_assets) and [rebuild the search index](#rebuild-the-search-index), which still name the old ids.

Nothing but those two migrations checks for the reset. The api holds no pin, and every layout-1 id clears the new floor, so a layout-1 row left behind would sit beside layout-2 ones unnoticed. A user-service database that already holds a pin refuses a build of another layout with the mismatch error above. An old caller sending `bucket` to `POST /v1/ids` gets `400`: the body is `{ "count"?: 1..1024 }`.

**There is no rolling back one service.** An old build cannot read layout-2 ids, and an old id-service replica claims the new nodes above 30 first: node 31 was layout 1's scripts node, and on any higher one the replica never becomes ready. Rolling back repeats the steps above for the old builds: stop, restore the step-3 dumps into empty databases, flush Redis, shrink the id-service's node pool back, put `IDENTITY_BUCKET_KEY` back with its old value, and deploy the old builds. Those builds predate the etcd lease store, so the id-service first goes back to `id-postgres` ([Roll back the cut-over](#roll-back-the-cut-over)), and the pool shrinks there:

```sql
-- psql against id-service's DATABASE_URL, every replica stopped
DELETE FROM node_leases WHERE node_id > 30;
ALTER TABLE node_leases DROP CONSTRAINT node_leases_node_id_range;
ALTER TABLE node_leases ADD CONSTRAINT node_leases_node_id_range CHECK (node_id BETWEEN 1 AND 30);
```

---

## Backup and restore

Each service owns one database and is backed up on its own: the api's (catalog, cart, media, messaging, and the retired order tables nothing writes), the user-service's (accounts, tokens, the layout pin), the order-service's `order-postgres` (orders, idempotency keys, its outbox and inbox), the inventory-service's `inventory-postgres` (stock levels, holds and their per-order headers) and the payment-service's `payment-postgres` (payment headers, attempts, the webhook ledger and its outbox). They share no foreign keys, so a restore cannot break a constraint; but the order-service's orders and the two participants' headers describe the same checkouts, so restoring one to another point in time than the others shows up as [CheckoutInvariantViolation](#checkoutinvariantviolation) on the orders in between. The id-service has no database: its node floors live in etcd, which is never backed up but rebuilt from the clock ([The keyspace is lost](#the-keyspace-is-lost)).

### Back up

```bash
# local — against whatever DATABASE_URL points at, one service at a time
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > backup-$(date +%Y%m%d-%H%M).dump
```

### Restore

```bash
# local — into an EMPTY database
createdb jcool_restore
pg_restore --dbname="postgres://…/jcool_restore" --no-owner --no-privileges backup-….dump
```

A user-service dump then needs the service booted against it by a build with the **id layout that dump was taken under**; the api's carries no pin.

After restoring the api's database, [rebuild the search index](#rebuild-the-search-index) before
catalog writes resume. A restore rewinds `products.search_version`, so the engine holds versions the
database no longer reaches and would ignore every later write to those products until they caught up.

### Restoring a dump taken under a different layout

The user-service's dump carries the `identity_key_pin` row, so the restored database still remembers the layout it was built under. Booting a build with another `LAYOUT_VERSION` against it **refuses to start** with the mismatch error above. That is the designed outcome — it is the check working, not a restore problem.

Consequences to plan for:

- A layout-1 dump cannot be served by a layout-2 build, and its ids do not decode under layout 2. Restore it only under the build that took it.
- A dump restored into a database that already has a *different* pin row will fail on the primary key of `identity_key_pin` during `pg_restore`, not at boot. Restore into an empty database.
- Never "fix" a mismatch by updating `identity_key_pin`. Every existing id was minted under the pinned layout; changing the pin makes the database lie about its own history.

---

## Rebuild the search index

`/products/search` reads a **derived** index. Postgres is the source of truth, so the index can always be thrown away and rebuilt — it is never restored from a backup. Live writes keep it current through the outbox ([decision record](./docs/system-architecture.md#search-index-consistency)). Rebuild when one of these happened:

- **A deploy changed the index definition** (`index-settings.ts`) other than by adding a field. Boot adds new fields to the live index and nothing else. A changed field type or analyzer name fails there and logs `search index provisioning failed`; a changed setting (the analyzer's filters, `max_result_window`) is not applied at all, and nothing says so. Rebuild right after that deploy, within the retry horizon (about 33 minutes), while any writes the old mapping refuses are still retrying.
- **`SEARCH_ENABLED` was turned on** in an environment that ran with it off. Catalog events consumed meanwhile changed nothing.
- **Catalog entries were dropped from the DLQ** instead of replayed.
- **The api's database was restored** ([Restore](#restore)).
- **The `products` alias is gone.** Search answers empty until the rebuild puts it back.

```bash
# local — needs SEARCH_ENABLED=true, SEARCH_URL, SEARCH_PASSWORD, and DATABASE_URL on the database you mean
pnpm search:reindex

# container — the compiled twin, since `tsx` is a devDependency and is not installed there
npm run search:reindex:prod
```

The command boots a **minimal** Nest context — config + database + the search adapter only — so no queue consumers or scheduled sweeps run for its lifetime. It fills a fresh `products_v<epoch ms>` from Postgres page by page, tombstones included, behind the `products_rebuilding` alias; every live write reaches that index as well as the one search reads. It then moves `products` onto the new index in one atomic call and, `--grace-seconds` later (30 by default), deletes the indices search no longer uses. Search answers from the old index until the swap, so it never goes empty.

It refuses to run when `SEARCH_ENABLED` is not `"true"`, deliberately: the search adapter is a silent no-op when search is off, so an unguarded rebuild would report success over an untouched index. That is the one failure this command must never hide.

Before running it:

- **Check which database it reads.** Nothing stops an empty or wrong fill from being promoted, and the index it replaced is deleted by the time the command returns. In the container `DATABASE_URL` is production's; locally it is whatever `.env` says.
- **Wait for any rollout to finish.** A replica of the previous release still consuming events writes documents in its own shape, and the fill cannot replace a document already at its row's version.
- **On a large index, give the command a longer timeout.** Every engine call, the refresh before the swap and the deletes included, is bounded by `SEARCH_REQUEST_TIMEOUT_MS` (5 s by default): `SEARCH_REQUEST_TIMEOUT_MS=60000 npm run search:reindex:prod`.

**One rebuild at a time.** `products_rebuilding` is the lock: a second run fails with `a search index rebuild is already in progress` while one fills. Ctrl-C (or `SIGTERM`) stops the fill at the next page and drops the half-built index; repeats are ignored while it cleans up. A hard crash (`kill -9`, an OOM kill, the container replaced, possibly a dropped `railway ssh` session) cannot clean up: it leaves the lock and the half-built index, live writes keep copying into it, and every later run refuses to start. So after any failed run, check the aliases (below). If `products_rebuilding` is still listed and no rebuild is running, rerun with `--clear-stale` (in the container: `npm run search:reindex:prod -- --clear-stale`, since npm keeps flags before `--` for itself): it drops the index holding the lock, then rebuilds. Never use it while another rebuild runs. It fails that run, which then leaves search on the index it was on.

**Verify.** The command prints `Rebuild complete: <n> documents and <m> tombstones; retired <indices>`. Documents must equal the searchable products, and both together the product count:

```sql
-- local, against the same database
SELECT count(*) FILTER (WHERE p.status = 'ACTIVE' AND c.archived_at IS NULL) AS documents,
       count(*) AS total
FROM products p JOIN categories c ON c.id = p.category_id;
```

Then look at the engine from the api container, signed in the way the api is:

```sh
# container (api) — the credentials come from this container's env
es() { node -e 'const [m, p] = process.argv.length > 2 ? process.argv.slice(1) : ["GET", process.argv[1]]; const e = process.env; fetch(e.SEARCH_URL + p, { method: m, headers: { authorization: "Basic " + Buffer.from(e.SEARCH_USERNAME + ":" + e.SEARCH_PASSWORD).toString("base64") } }).then(async (r) => console.log(r.status, await r.text()))' "$@"; }
es '/_cat/aliases/products*?v'   # products on the new index, no products_rebuilding
es '/_cat/count/products?v'      # documents plus tombstones
```

**Reindex is not part of deploy.** It is not in `preDeployCommand`, so a dead search engine still lets a deploy through — the index is an extra read path, never a boot requirement. The cost is that a type or analyzer change to the indexed document needs this run by hand afterwards.

---

## Reconcile the bucket against `media_assets`

Stores that must agree and cannot all be kept in one transaction. Three ways they can disagree:

```bash
# local — needs DATABASE_URL and the four STORAGE_* settings
pnpm storage:verify

# narrow the scan
pnpm storage:verify --prefix media/ --limit 5000

# container — the compiled twin, since `tsx` is a devDependency and is not installed there
npm run storage:verify:prod
```

**Read-only. It deletes nothing**, and that is deliberate: what to do differs per direction, and neither answer is safe for a script to guess. It exits `1` when anything is found, so a scheduled run fails loudly.

| Finding | Means | Do |
| ------- | ----- | -- |
| **orphan object** — bytes in the bucket no row points at | Storage being paid for with nothing left that could ever reference it. Either a `PUT` that landed after its row was swept, or bytes written to the bucket outside the app. **Not** a crashed sweep: that deletes the object first and the row second, so it leaves a `SWEEPING` row whose object is gone — a state this tool does not report at all | Delete the object by hand; no row exists for a sweep to ever claim it, so re-running changes nothing. It is not a scan artefact either — candidates are re-read against the database before being reported |
| **missing object** — an `ATTACHED` row whose object is gone | A product is rendering a broken image **right now**, and bytes were deleted while something still pointed at them. Never expected | Detach the image (`DELETE /admin/products/:productId/images/:imageId`) so the page stops breaking, then re-upload. Find out what deleted it — the sweep cannot select an `ATTACHED` row |
| **dangling link** — a `product_images` row whose `media_assets` row is gone | There is no FK between them (separate contexts), and the read path *hides* this: an asset id that resolves to no URL is dropped from the response rather than rendered broken | Detach the image, then re-upload. The product visibly loses an image, but nothing anywhere raises an error about it — this table is the only place it is reported |

It boots no Nest context at all — it needs only Postgres and the bucket, and it is most useful when the app is what is suspect.

### CORS, content sniffing and downloads are bucket configuration, not app code

The app signs `Content-Type` on upload and stores only what the allowlist permits, so nothing else can be written *through* it. What it does **not** control is anything the browser does directly against the bucket. Three settings belong on the bucket or the CDN in front of it, and the first one is not optional:

- **CORS**, allowing `PUT` from the admin origin with `Content-Type` among the permitted request headers — that header is the whole of what the preflight has to clear, since the signature travels in the query string and no `Authorization` header is sent. Without it the design fails in exactly one environment: `curl` uploads fine, the browser's preflight is refused, and "the client writes straight to the bucket" is false in the only place it matters. Nothing in this repo provisions it — set it when the bucket is created.
- **`X-Content-Type-Options: nosniff`** — without it a browser may sniff past the stored `Content-Type`, and a file that was uploaded as an image but parses as markup can execute on the bucket's origin.
- **`Content-Disposition: attachment`** (or a bucket domain isolated from the app's) — so a direct object URL downloads rather than renders in a context that shares an origin with anything.

None of the three can be enforced from this codebase; they belong in the bucket/CDN policy, and the last two are why `STORAGE_PUBLIC_BASE_URL` should point at a domain that hosts nothing else.

---

## Outbox relay is not draining

`OutboxMessageStale` pages on `outbox_oldest_age_seconds > 60`. The gauge is an **age**, so one row that can never publish pins it forever and looks identical to a relay that stopped — but the two need opposite responses. `attempts` is what separates them:

```sql
-- local — the oldest unpublished rows and how often each has been refused
SELECT id, event_type, attempts, created_at
FROM outbox
WHERE published_at IS NULL
ORDER BY created_at, id
LIMIT 20;
```

- **`attempts` climbing on one row while others publish** — that row is poison, and the backlog behind it is moving. The relay only charges an attempt when something else in the same tick got through, so a non-zero count is proof the queue itself is healthy. Fix the payload or the handler; the row keeps its place in line meanwhile.
- **`attempts` flat at 0 across the whole backlog** — nothing is publishing. Either the relay is not running (`OUTBOX_RELAY_ENABLED`, the worker process) or Redis is refusing every publish. Check `outbox_backlog_pending` alongside it: a deep backlog with a flat age is a burst being worked through, not an outage.

The api, the order-service and the payment-service each run a relay over an `outbox` of their own, and the alert carries the `job` label of the one that is stale (`jcool-api`, `jcool-order` or `jcool-payment`): run the query against that service's database (`order-postgres`, `payment-postgres`). A stale payment-service row is a `payment.authorized` that has not reached the saga yet; a stale order-service row is an `order.*` event its own worker has not seen yet.

A row here has **not** been dead-lettered — it was never delivered at all, so [replay](#replay-the-dead-letter-queue) does not apply to it and there is nothing to re-admit.

---

## Replay the dead-letter queue

Each queue has one consumer and a dead-letter queue of its own. A message reaches it after `QUEUE_CONSUMER_ATTEMPTS` (default 8) deliveries fail, or `ORDER_PAID_CONSUMER_ATTEMPTS` (default 15) for the events on the long ladder: `order.paid`, which [waits out a user-service outage](#orderpaid-waits-for-the-user-service), `payment.authorized`, which waits out a Temporal outage, and `catalog.*`, which wait out a search engine outage. A replay puts each message back on its own ladder. **Nothing consumes the DLQ** — that is deliberate. A queue that drains itself hides the outage that filled it.

### Dead-letter queues

The `DeadLetterQueued` page names the service (`job`) and the event type (`messaging_dlq_total{event_type}`), which say which replay to run. Each service's CLI knows only its own queue, because the inbox it checks is in that service's database:

| Event type | Queue | Dead-letter queue | Consumer (`job`) | Replay with |
| ---------- | ----- | ----------------- | ---------------- | ----------- |
| `order.placed`, `order.paid`, `order.failed`, `order.expired`, `order.cancelled`, `payment.authorized` | `order-events` | `order-events-dlq` | order-service (`jcool-order`) | `pnpm queue:replay-dlq:order --queue order-events` |
| `catalog.product.changed`, `catalog.category.renamed` | `api-events` | `api-events-dlq` | api (`jcool-api`) | `pnpm queue:replay-dlq --queue api-events` |

`--queue` is required even though each CLI has one queue: a value for the other service's queue exits 1 instead of draining a DLQ against the wrong inbox. The payment-service publishes `payment.authorized` but never consumes it, so it has no DLQ: that job fails in the order-service's worker and lands in `order-events-dlq`, and the replay runs in the order-service. The order-service's CLI runs compiled even locally, so `pnpm --filter @jcool/order-service build` comes first.

### The inbox guard

**Replay used to be unconditionally safe. It is not any more, and the tool now says so.** The old guarantee was that a message goes back under its outbox row id, the inbox dedups on that id, and a needless replay collapses into nothing. [Inbox retention](#retention-sweeps) ends it: once a claim has been swept, "no claim" no longer means "never applied", and replaying such a message applies its effect a second time.

So the CLI asks the database as well as Redis, and decides per message:

| Inbox claim for the message | Decision |
| --------------------------- | -------- |
| Present | **Refused, and `--force` cannot override it.** A replay would be a silent no-op you would read as a fix |
| Absent, `occurredAt` inside `RETENTION_INBOX_DAYS` | Replayed — the ordinary case |
| Absent, `occurredAt` older than that | Refused unless `--force`: the claim may simply have been swept |

The second and third rows turn on `occurredAt` — when the outbox row was written — and the choice of field is the whole argument. What those rows must establish is not that the message is old but that **if it had been applied, its claim would still be here to say so**. A claim is swept only once its `processed_at` falls outside the window, and nothing can be processed before it was produced, so a message born inside the window cannot have had a claim swept out from under it. Its absence is then proof it was never applied.

`failedAt` cannot carry that argument and does not decide anything. It is re-stamped on every dead-lettering, so it means "when it last failed" — a message applied a month ago and parked again this morning carries a brand-new `failedAt` and a guard keyed on it would wave through exactly the message most likely to have been swept. It is still printed in the refusal, because it is the diagnosis you need in order to judge a `--force`.

**Before using `--force`**, establish by some other means that the effect never happened — the order has no payment, the stock was never decremented, the email was never sent. `--force` is you asserting that, not the tool checking it.

**Run it inside the deployed container of the queue's consumer**, via `queue:replay-dlq:prod`. The horizon comes from the `RETENTION_INBOX_DAYS` of whatever environment the CLI process itself starts in, so running it from a laptop whose `.env` omits the variable silently draws the window at the 30-day default while the server may be keeping claims for seven — re-admitting precisely the replays the third row exists to refuse. The window in force is echoed in the header the command prints; check it matches the deployment before `--apply`.

What replay **cannot** fix in any case is the reason the message failed. Each line prints it as `[parked: <reason>]`; deploy the fix first, or the same messages come straight back.

```bash
# local — dry run is the default, because this puts real traffic back on a live queue
pnpm queue:replay-dlq:order --queue order-events
pnpm queue:replay-dlq:order --queue order-events --apply
pnpm queue:replay-dlq --queue api-events --apply --limit 20
pnpm queue:replay-dlq:order --queue order-events --apply --force   # past the retention horizon; read above first
```

```bash
# container — same tool, compiled. `tsx` is a devDependency and is not installed here.
npm run queue:replay-dlq:prod -- --queue order-events   # railway ssh --service order-service
npm run queue:replay-dlq:prod -- --queue api-events     # railway ssh --service jcool-ecommerce-backend
npm run queue:replay-dlq:prod -- --queue order-events --apply
```

The guard runs on a dry run too, so the listing is what `--apply` would actually do rather than a promise it would then refuse.

**A `catalog.*` message is always safe to replay, `--force` included.** Its handler re-reads the product from Postgres and writes it as it is now, and the engine ignores any version it already holds, so a second application changes nothing. A `catalog.category.renamed` can also land here as permanent without any engine fault: a deploy that outlasts the worker's 10 s close window interrupts its fan-out, and a second such interruption exceeds BullMQ's stall limit. Replaying it restarts the fan-out from the first page. Dropping catalog messages instead of replaying them is fine too, provided a [rebuild](#rebuild-the-search-index) follows.

The CLI reads its Redis URL, queue prefix **and inbox window** through the app's own config factory rather than re-reading the environment, so it cannot report a reassuringly empty queue by looking under a different prefix than the app writes to, nor draw the horizon in a different place than the sweep does. It boots no Nest context at all — a replay is something you want to be able to run while the app itself is the thing that is broken. It now needs **Postgres as well as Redis**, the consumer's own, since the inbox lives there: the inbox check is not optional, so a replay cannot be performed while the database is down.

---

## Retention sweeps

Each service runs its own timer (`RETENTION_INTERVAL_MS`, hourly by default) over its own tables — in the api `media:assets` and the two `messaging:*` ones, in the order-service `order:idempotency-keys`, `order:rejected-orders` and the two `messaging:*` ones, the three `auth-tokens:*` ones in the user-service, and in the payment-service the outbox one and `payment:webhook-events`. Failures, timeouts and the "still running" guard are **per sweep**: one broken table cannot cost the others their tick.

Every window is sized by **what still has to be able to retry against the row**, never by disk. Shortening one does not lose history; it loses a guarantee, and only under retry — which is to say only during an incident.

| Sweep | Table | Collected when | Never collected | Env var |
| ----- | ----- | -------------- | --------------- | ------- |
| `messaging:outbox` *(api, order-service, payment-service)* | `outbox` | `published_at` older than the window | **Any row with `published_at IS NULL`, at any age** — that is an unsent event, not a stale record | `RETENTION_OUTBOX_DAYS` (30) |
| `messaging:inbox` *(api, order-service)* | `inbox` | `processed_at` older than the window | — | `RETENTION_INBOX_DAYS` (30, floor 7) |
| `order:idempotency-keys` *(order-service)* | `idempotency_keys` | `expires_at` past, plus a grace | Anything still inside its TTL, **`COMPLETED` included** — that row is the response a retry replays | `RETENTION_IDEMPOTENCY_GRACE_SEC` (3600) |
| `payment:webhook-events` *(payment-service)* | `webhook_events` | `received_at` older than the window | — | `RETENTION_WEBHOOK_EVENT_DAYS` (30, floor 14) |
| `order:rejected-orders` *(order-service)* | `orders` (and their `order_items`) | `REJECTED` with `finalized_at` older than the window | Every other status — those are the buyer's record | `RETENTION_REJECTED_ORDER_DAYS` (30, floor 1) |
| `auth-tokens:email-verification` *(user-service)* | `email_verification_tokens` | expired, or consumed, longer ago than the grace | A token that can still be spent | `RETENTION_AUTH_TOKEN_GRACE_DAYS` (7) |
| `auth-tokens:password-reset` *(user-service)* | `password_reset_tokens` | same | same | `RETENTION_AUTH_TOKEN_GRACE_DAYS` (7) |
| `auth-tokens:refresh` *(user-service)* | `refresh_tokens` | expired past the token grace **and never revoked**, or revoked past the refresh grace | A revoked token inside its own, much longer grace — whether or not it has also expired | `RETENTION_REFRESH_TOKEN_GRACE_DAYS` (30, floor 30) |
| `media:assets` | `media_assets` **and the objects behind them** | `expires_at` past, or a `SWEEPING` claim older than `RETENTION_SWEEP_TIMEOUT_MS` | **Anything `ATTACHED`** — those rows have no `expires_at` at all, so no query the sweep can write will match them | `MEDIA_UPLOAD_TTL_SEC` (3600) / `MEDIA_READY_TTL_SEC` (86400) |

`media:assets` is the only sweep that deletes something outside Postgres, and the only one whose work is not undoable by restoring a backup. It deletes **the object first, then the row**: a crash between the two leaves a row whose object is gone, which the next pass re-scans and finishes (deleting an absent object is a no-op). The reverse order would leave bytes nothing points at — unfindable and billed forever. If a pass dies mid-flight the claim is left at `SWEEPING`, and a claim older than the sweep's own timeout is assumed dead and picked up again.

`reservations` is deliberately **not** in this list. Those rows are released by the checkout saga, or by the lapsed-hold sweep behind it, which is a state machine driving stock back to available — not retention.

### The two horizons that are not preferences

**Inbox.** `RETENTION_INBOX_DAYS` must exceed how long the queue can still redeliver a message:

```
RETENTION_INBOX_DAYS × 86400  >  REMOVE_ON_FAIL_AGE_SEC   (604800, i.e. 7 days)
```

A failed job is re-runnable for exactly that long. Sweep its claim first and the re-run is indistinguishable from a first delivery — the effect is applied twice, silently. **The app refuses to boot** on a value that violates this, with the arithmetic in the error. The dead-letter queue has no age limit at all and so no comparable bound, which is why the DLQ side is handled at replay time by querying the inbox rather than by a clock.

**Revoked refresh tokens.** Expiry is age; revocation is evidence. A revoked row is what reuse detection matches an incoming token against, so collecting it on the expiry clock turns a detected replay — the signal that a refresh token leaked — back into a successful refresh. Hence a separate grace, an order of magnitude longer, with a 30-day floor in env validation.

The subtle part is that the expiry arm is restricted to rows that were **never** revoked. Every rotation revokes its predecessor, so a rotated token carries both timestamps, and `rotate` checks revoked-or-replaced *before* it checks expiry precisely so an expired-but-retired token coming back still reads as reuse. An expiry arm that ignored `revoked_at` would therefore collect rotated tokens on the short clock: at the default 7-day TTL and 7-day expiry grace they would go at about day 14, and the 30-day floor above would be fiction for every token that had ever been rotated. If you widen `RETENTION_AUTH_TOKEN_GRACE_DAYS`, that arm still only touches tokens that died of old age unused.

### What to watch

| Signal | Means |
| ------ | ----- |
| `retention_rows_deleted_total{sweep}` flat | Either nothing to collect **or** the sweep is not running. The failure counter is what tells the two apart |
| `retention_sweep_failures_total{sweep}` rising | That one table is not being reclaimed. Per label — it says nothing about the others |
| `media_assets_sweeping` above zero and staying there | The media sweep is claiming rows but its bucket deletes are failing. The objects behind those rows are still being paid for; check storage credentials and endpoint reachability |
| `retention sweep filled its batch` (warn) | The batch is a cap, so a full one means there was more to give. Once is a backlog being worked off; every tick forever means rows arrive faster than this reclaims them and the table grows *despite* the sweep. Raise `RETENTION_BATCH_SIZE`, shorten the window, or shorten the interval |
| `previous retention sweep still running` (warn) | One sweep is exceeding `RETENTION_SWEEP_TIMEOUT_MS`. The timeout ends the *wait*, not the DELETE, so the statement is still holding locks somewhere |

Every log line from a sweep carries a `requestId` and a `job` of `retention:<sweep name>` — one correlation id per sweep, not per tick, because a retention question is about one table at a time.

### Query plans

Measured 2026-09-07 on Postgres 16, 200k rows per table, seeded to resemble a table that has been running for months. The case that matters is the **steady state** — the backlog worked off, almost nothing old enough to collect — because that is what runs on 23 of every 24 ticks, and it is the case where `LIMIT` cannot help: the scan has nothing to find early.

| Sweep | Plan | Time |
| ----- | ---- | ---- |
| `messaging:outbox` | Index Scan `idx_outbox_published` | 0.04 ms |
| `messaging:inbox` | Index Scan `idx_inbox_processed` | 0.01 ms |
| `order:idempotency-keys` | Index Scan `idx_idempotency_expires` | 0.01 ms |
| `payment:webhook-events` | Index Scan `idx_webhook_events_received` | 0.01 ms |
| `auth-tokens:email-verification` | BitmapOr of `_expires` + `_consumed` | 0.02 ms |
| `auth-tokens:password-reset` | BitmapOr of `_expires` + `_consumed` | 0.02 ms |
| `auth-tokens:refresh` | BitmapOr of `_expires` + `_revoked` | 0.09 ms |

The three disjunctive predicates need **both** arms indexed or neither index is used. Measured with only one arm indexed, `email_verification_tokens` fell back to a parallel seq scan at 22 ms and `password_reset_tokens` to 15 ms — costs that grow with exactly the thing the sweep exists to bound. That is what migration 0018 is for; do not drop half a pair.

An index also has to match its arm's **whole** predicate, not just its column. `idx_refresh_tokens_expires` is partial on `revoked_at IS NULL` because that is the arm it serves; as a plain index on `expires_at` it measured a 41 ms seq scan on the same 200k rows, since on a mature table nearly every expired row has also been revoked and the index hands the planner a match list that is almost all rejects.

When a sweep is actively working off a backlog the planner correctly prefers a seq scan instead: it finds 500 matching rows within the first few pages and stops. Both shapes are healthy.

---

## A refund is owed

`payment_refund_owed_total` rising means money reached a buyer's payment for an order that will not be fulfilled. **This service does not refund anything automatically** — automatic refunds are out of scope — so every increment is a person's job, and nothing retries it away.

How it happens: checkout sessions are manual capture, so a buyer who authorizes after a cancel or the payment deadline is voided, never charged, and owes nothing. What is left is a webhook reporting cleared money on a session no `payment_orders` header owns: a session opened outside the payment-service, or one whose header a restore or a manual cleanup lost. Nothing will ever capture or void it.

The counter counts **observations, not refunds**: a redelivered webhook is deduplicated before it counts, but the same session reported under two event ids counts twice.

| `source` | Who saw it |
| -------- | ---------- |
| `webhook_direct` | The payment-service's webhook handler (`HandlePaymentWebhook`) saw a cleared charge for a session no checkout owns; the event is recorded `SKIPPED` |

To act on one, find the session: the payment-service's log line is at `error` with `providerEventId` and `sessionId`. The session's `order_id` metadata in the gateway dashboard names the order, if any. Then read the money and the order side back, from the two databases they live in —

```sql
-- payment-postgres
SELECT id AS payment_id, order_id, status AS payment_status, provider_session_id, provider_intent_id
FROM payments WHERE order_id = '<orderId>';
-- order-postgres
SELECT id, status, finalize_reason, total_amount FROM orders WHERE id = '<orderId>';
```

An order in `CANCELLED` / `EXPIRED` / `FAILED` carrying a `SUCCEEDED` payment is owed a refund. Refund `provider_intent_id` in the gateway's own dashboard; the order and the stock are already correct and must not be edited to match. If the order reads `PAID`, nothing is owed: the saga captured that charge itself. When no local payment matches the session at all, the gateway dashboard is the only record, and the refund is owed from the session's payment intent once its `payment_status` reads `paid`.

To find every candidate rather than chase one log line — orders that died holding money that was never resolved — list the attempts that hold or took money, then keep the ones whose order died:

```sql
-- payment-postgres
SELECT order_id, status AS payment_status, provider_session_id, provider_intent_id, updated_at
FROM payments WHERE status IN ('PENDING', 'SUCCEEDED') ORDER BY updated_at DESC;
-- order-postgres, with those order ids
SELECT id, status, finalize_reason, updated_at
FROM orders WHERE id IN ('<order id>', …) AND status IN ('CANCELLED', 'EXPIRED', 'FAILED');
```

`SUCCEEDED` rows on a dead order are owed refunds outright. `PENDING` rows are almost always a buyer who simply never paid, and their sessions read `expired`; check the session in the dashboard when in doubt.

---

## Apply migrations out of band

Railway runs `npm run db:migrate:prod` as `preDeployCommand`, so the normal path needs no operator. Run it by hand only when a deploy failed *after* the image built but before migrations applied, or when restoring.

```bash
# container
npm run db:migrate:prod
```

```bash
# local — drizzle-kit, reads apps/api/drizzle.config.ts
pnpm db:migrate
```

The services with a database of their own (the user-service, the order-service, the inventory-service, the payment-service) migrate the same way from their own pre-deploy command, `node dist/database/migrate-cli.js` (the inventory-service's `pre-deploy-cli.js` also seeds), and locally with `pnpm --filter @jcool/<service> db:migrate` after a build of that service.

The compiled CLI fails loudly if its migrations directory resolves to a readable but wrong path: a directory with zero `.sql` files would otherwise make drizzle report "nothing pending" and exit 0 — a green deploy onto an empty schema. In the image `MIGRATIONS_DIR=/app/migrations`, absolute because the image ships no `src/` tree.

**Run exactly one migration process at a time.** `runMigrations()` takes no advisory lock, so two concurrent runs race on `__drizzle_migrations`. This is why the api is a single Railway service.

### The id-type migrations only apply to empty tables

Two migrations moved user ids from `uuid` to `bigint`, and they are written to fail rather than guess:

| Service | Migration | What it does |
| --- | --- | --- |
| api | `0022_round_green_goblin.sql` | drops and re-adds `carts.user_id`, `orders.user_id`, `media_assets.uploaded_by` as `bigint NOT NULL`, then rebuilds the indexes over them |
| user-service | `0000_users_baseline.sql` | the baseline itself was regenerated; there is no in-place step from the old one |

Postgres has no cast from `uuid` to `bigint`, so an `ALTER COLUMN … SET DATA TYPE` would be refused outright. `ADD COLUMN … NOT NULL` with no default succeeds on an empty table — every new environment and every CI run — and fails on a populated one. That failure is the correct outcome, not an obstacle: those rows point at user ids that no longer exist anywhere, and there is no mapping back.

Two later migrations, api `0023_same_winter_soldier.sql` and user-service `0001_yellow_tomas.sql`, added a `CHECK (… >= 4194304)` to every snowflake id column (`ck_<table>_<column>_routable`), a floor of 2^22 under layout 1. They validate the rows already there, so either one fails on a database holding an id below that floor. No app writer produces such an id; a row like that was written by hand. Layout 2 lowers the floor to 2^18 (`>= 262144`) in api `0028_snowflake_layout_v2_id_floor.sql` and user-service `0003_snowflake_layout_v2_pin_and_id_floor.sql`; see [Changing the id layout](#changing-the-id-layout). The api and user-service ones refuse to run while any of their tables holds a row, since they assume the reset described there.

Two more move every remaining id to `bigint`, and these **delete data rather than fail**:

| Service | Migration | What it does |
| --- | --- | --- |
| api | `0027_snowflake_ids.sql` | `TRUNCATE`s all 17 api tables — catalog, carts, orders, stock, payments, webhook events, media, outbox, inbox — then converts every id and reference column and adds its `CHECK` |
| user-service | `0002_refresh_token_family_snowflake.sql` | deletes every refresh token, so every user signs in again, then converts `family_id` |

**Back up both databases before deploying them** ([Backup and restore](#backup-and-restore)). The api's rows cannot be carried across: a uuid has no bigint form, and nothing maps the old ids to new ones. Objects already in the media bucket outlive their rows, so [reconcile the bucket](#reconcile-the-bucket-against-media_assets) afterwards, and [rebuild the search index](#rebuild-the-search-index), which still names the old product ids.

**Scale the api and the user-service to zero before this deploy.** The migrations run in the pre-deploy step while the previous deployment still serves, and that code writes uuids into what are now bigint columns: every api write and every user-service sign-in answers 500, and the old workers dead-letter each event the new relay publishes. Let the new deployment come up alone. Jobs the old code left in Redis carry uuid ids; the new workers dead-letter them as malformed and the replay CLI skips them. They name rows the migration deleted, so leave them to expire.

So on a development or staging database that still holds rows, recreate it rather than migrating it:

```bash
docker compose --profile '*' down -v   # every profile, so all three Postgres volumes go
docker compose up -d postgres redis elasticsearch mailpit minio minio-init
pnpm db:migrate && pnpm db:seed
```

The user-service's database comes back the same way — its container runs its own migrate step (`--profile user-service`). Back up first if anything in there is worth keeping; see [Backup and restore](#backup-and-restore). The id-service's etcd volume goes with them, and the `id-floors` one-shot in front of its replicas lifts the fresh keyspace's floors.

---

## Change Railway service config

`.railway/railway.ts` owns every service's build and deploy settings and the **names** of their variables. Values set by hand stay in Railway (`preserve()`); the rest are literals or references in the file. Before every deploy, CD plans that file, writes the plan to the run summary, and applies exactly the change set it showed, so:

- **Settings** (healthcheck, pre-deploy command, overlap, replicas) change only in that file. A dashboard edit is reverted by the next deploy.
- **Deploys** go id-service → user-service → inventory-service → payment-service → order-service → api → gateway, each waiting for the previous one to go live (`scripts/railway-wait-for-rollout.sh`), so a callee's allowlist and routes are out before the caller that needs them. Only the api has a repo source, so only CD's `railway up` deploys the others; a dashboard redeploy rebuilds their last upload.
- **New variable**: add its name to the service's `env` (for the api, `API_VARIABLES`) in the same PR, or before, that needs it, then set the value in the dashboard. A variable that exists in Railway but not in the file turns the plan into a delete, and the deploy waits for review (below). This includes one set by hand during an incident: reject that run, add the name to the file, and merge.
- **Removing a variable**, a service, a volume or a database is the destructive path. Drop it from the file and merge.

### Review a destructive change

When the plan deletes anything, the "Confirm destructive Railway changes" job waits on the `production-destructive` environment until a required reviewer acts on it from the run page (**Review deployments**):

1. Read the "Plan Railway config" job's summary. The only destroys must be the ones the merge meant.
2. **Approve** to apply that change set and deploy. **Reject** to stop with nothing applied.

The deploy job plans again and applies only if the change set still hashes to the one shown in the summary; otherwise it stops with `the Railway plan changed after review`, and **Re-run all jobs** plans afresh for a new review. An empty plan means the change already landed, so the job skips the apply and deploys. That is how a procedure that must apply by hand between the merge and the deploy works: leave the run waiting, apply from a checkout of `main`, then approve it.

```bash
# local, after `railway link` to the production service
railway config plan
railway config apply --confirm-destructive
```

A waiting run holds every later CD run behind it (`concurrency: cd-production`), so approve or reject it rather than leaving it open.

`production-destructive` has no secrets; it exists for the reviewer rule, and the job refuses to pass if the rule is missing, since GitHub creates an environment a job names with no rules at all. To create it:

```bash
gh api -X PUT repos/jCool10/jcool-ecommerce-backend/environments/production-destructive --input - <<'JSON'
{"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":84013644}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api -X POST repos/jCool10/jcool-ecommerce-backend/environments/production-destructive/deployment-branch-policies \
  -f name=main -f type=branch
```

`prevent_self_review` stays `false` while one person both merges and approves.

Never pass `--show-values` or `--decrypt-variables` in CI. The repo is public, and so are its Actions logs and run summaries.

---

## Enable Stripe test mode on Railway

The payment-service creates a Stripe Checkout Session when the order-service asks for one on `/pay`, and records the authorization from the webhook. Production refuses to boot without `STRIPE_SECRET_KEY` and `STRIPE_SUCCESS_URL`, so set all four variables on the `payment-service` before the deploy that needs them. All of them are declared `preserve()`d in `.railway/railway.ts`, so an apply never reverts them. The api's copies were deleted at the [checkout cut-over](#cut-checkout-over-to-the-order-service), which also ended the rollback of the [payment cut-over](#cut-payments-over-to-the-payment-service) that needed them.

1. **Create the webhook endpoint** in the Stripe dashboard, in test mode: URL `https://<public domain>/webhooks/payment`, events `checkout.session.completed` and `checkout.session.expired`. The gateway routes that path to the payment-service. Copy its signing secret (`whsec_…`).
2. **Set the payment-service variables**, the secret key last, each without a deploy of its own:

   ```bash
   # local, after `railway link`; paste the value, then press Enter (it is not echoed or kept in history)
   read -rs VALUE; printf '%s' "$VALUE" | railway variable set STRIPE_SUCCESS_URL --stdin --service payment-service --skip-deploys
   read -rs VALUE; printf '%s' "$VALUE" | railway variable set STRIPE_CANCEL_URL --stdin --service payment-service --skip-deploys
   read -rs VALUE; printf '%s' "$VALUE" | railway variable set PAYMENT_WEBHOOK_SECRET --stdin --service payment-service --skip-deploys
   read -rs VALUE; printf '%s' "$VALUE" | railway variable set STRIPE_SECRET_KEY --stdin --service payment-service --skip-deploys
   ```

   `STRIPE_SUCCESS_URL` must contain `{CHECKOUT_SESSION_ID}`, for example `https://<storefront>/payments/success?session_id={CHECKOUT_SESSION_ID}`. `PAYMENT_WEBHOOK_SECRET` is the `whsec_…` from step 1 and `STRIPE_SECRET_KEY` is the `sk_test_…` key.
3. **Deploy** the payment-service, then check:
   - `POST /orders/<id>/pay` returns a `checkout.stripe.com` URL.
   - Pay it with card `4242 4242 4242 4242`, any future expiry and any CVC.
   - The order becomes `PAID` once the saga captures the authorization the webhook reported, not through the redirect, and the Stripe dashboard shows a `2xx` delivery for the endpoint.

---

## Freeze checkout

`CHECKOUT_WRITE_FREEZE=true` makes the gateway answer every `POST` to `/orders` and `/orders/*` (create, `/pay`, `/cancel`) with `503` and `Retry-After: 120`, before the request reaches the order-service. Reads, `/admin/orders/*` and `/webhooks/payment` are untouched, so a payment already in flight still lands and an admin can still cancel. Use it while a change must not race an order write. It is off unless set, is set by hand, and is kept across every apply. The value is read when the gateway starts, so each change redeploys it; the gateway's healthcheck goes to the api, so that works while Temporal or the order-service is down.

The freeze is its own top-level `handle` in `apps/gateway/Caddyfile`, placed before the order route's: a request enters only one `handle`, so a freeze matcher below `handle @orders` would never see a `POST /orders`. `order-routing.system-spec.ts` checks the order upstream gets no request while frozen.

```bash
# enable
railway variable set CHECKOUT_WRITE_FREEZE=true --service gateway
scripts/railway-wait-for-rollout.sh gateway
curl -i -X POST https://<public domain>/orders
curl -i -X POST https://<public domain>/orders/1/pay
```

Both probes must answer `503` with `Retry-After: 120`.

```bash
# disable
railway variable set CHECKOUT_WRITE_FREEZE=false --service gateway
scripts/railway-wait-for-rollout.sh gateway
curl -i -X POST https://<public domain>/orders
```

The probe must no longer answer `503`; the order-service answers it, typically `401` without a token.

If the public domain does not point at the gateway yet, probe through the gateway's temporary domain instead (see [Probe on a temporary domain](#probe-on-a-temporary-domain)).

---

## Deploy the monitoring stack

`prometheus` and `grafana` are two ordinary Railway services declared in `.railway/railway.ts`, built
from `infra/prometheus/Dockerfile` and `infra/grafana/Dockerfile`. Railway has no bind mounts, so
each image **bakes** the config that compose mounts from the host; `.dockerignore` re-includes those
files from the otherwise excluded `infra/` and keeps `infra/prometheus/secrets/` out.

Neither is in `cd.yml`, and neither has a repo source: they are deployed by hand, which is right for
config that changes a few times a year.

First time, from an up-to-date `main`:

```bash
# A token shorter than 16 characters fails the api's env validation at boot.
railway variable set "METRICS_TOKEN=$(openssl rand -hex 24)" --service jcool-ecommerce-backend
railway variable set "GF_SECURITY_ADMIN_PASSWORD=$(openssl rand -hex 16)" --service grafana

# GRAFANA_ADMIN_PASSWORD leaves the api in the same change, so this first apply is destructive.
railway config plan                          # the only destroy must be that variable
railway config apply --confirm-destructive

railway up --ci --service prometheus
railway up --ci --service grafana
railway domain --service grafana --port 3000
```

Afterwards, a config change is `railway up --ci --service <prometheus|grafana>` on its own. The api
needs a redeploy the first time `METRICS_TOKEN` is set: `MetricsTokenGuard` reads it at boot, and
until then `/metrics` answers 404 and the target sits DOWN.

The rule files are baked into the image too, so a change anywhere under `infra/prometheus/` is live only after `railway up --ci --service prometheus`, and CD never runs it. Redeploy after every such merge, then check in the container (`railway ssh --service prometheus`) that the rules loaded and every service's series arrive:

```sh
# container (prometheus)
wget -qO- localhost:9090/api/v1/rules | grep -o '"file":"[^"]*"' | sort -u          # the seven files under rules/
wget -qO- 'localhost:9090/api/v1/query?query=checkout_saga_engine_up'                # one series, job jcool-order, value 1
wget -qO- 'localhost:9090/api/v1/query?query=up'                                     # jcool-api, jcool-order, jcool-inventory and jcool-payment all 1
```

The image refuses to start without `API_TARGET`, `ORDER_TARGET`, `INVENTORY_TARGET`, `PAYMENT_TARGET` and `LOKI_TARGET`, so a `railway up` from a `main` that scrapes a new target comes after the `railway config apply` that declares its variable.

Three constraints this stack depends on:

- **The SLIs select the public jobs.** The SLO recording rules in `infra/prometheus/rules/slo-burn-rate.yml` aggregate without `by (job)`, so each selects `job=~"jcool-api|jcool-order"`, the two services behind the storefront's routes, and leaves out `/internal/*` routes; a job added later stays out of the SLIs only if every new rule keeps that selector. `jcool-inventory` and `jcool-payment` are the other app jobs. The Grafana RED panels use the same selector. The `loki` job is safe only because its `metric_relabel_configs` keep nothing but the `loki_*` series `rules/loki.yml` reads.
- **Prometheus binds `[::]`** (`infra/prometheus/railway-entrypoint.sh`). Railway's private network
  is IPv6-only, and on the default `0.0.0.0` Grafana cannot reach it.
- **Grafana is the only public surface**, and the only one with a login. Prometheus has no domain.
  Grafana has no volume either: datasources and dashboards are provisioned from the image on every
  start, so a redeploy loses only ad-hoc UI edits.

---

## Logs in Loki

`loki` is a single-binary Loki (`infra/loki/`) with its chunks and index in the Railway Bucket
`loki-chunks`, and its WAL and compactor state on the `loki-data` volume. It has no domain and no
auth: only the private network reaches it. Grafana queries it through the provisioned `Loki`
datasource.

The api, user-service and id-service push every pino line to it when `LOKI_URL` is set, which
`.railway/railway.ts` does for all three. stdout is unchanged, so Railway's log explorer still has
every line for 30 days. The gateway's Caddy logs are not in Loki.

First time, from an up-to-date `main`:

```bash
railway config plan      # adds loki-chunks, loki-data, loki, LOKI_URL on three services, LOKI_TARGET
railway config apply
railway up --ci --service loki
scripts/railway-wait-for-rollout.sh loki
railway up --ci --service prometheus   # scrapes loki
railway up --ci --service grafana      # Loki datasource
```

The apply redeploys every service whose variables it changed, so the three apps restart at once on
the code they already run (the api rebuilds `main` from its GitHub source). They read `LOKI_URL` at
boot, and each starts pushing once it runs code that knows the variable. Loki itself is deployed by
hand, like Prometheus and Grafana: a config change is `railway up --ci --service loki`.

Querying, in Grafana → Explore → Loki:

```logql
{service="jcool-api", level="error"}
{env="production"} | json | requestId="0f9c…"
sum by (service) (count_over_time({env="production", level=~"error|critical"}[5m]))
```

Labels are `service`, `env`, `level` and `hostname` (one per replica, new on each deploy). `level`
is pino-loki's name, not pino's: `debug`, `info`, `warning`, `error`, `critical` — `level="warn"`
matches nothing. Anything unbounded (`requestId`, `traceId`, `userId`) is a field in the JSON line,
filtered with `| json`, never a label: every label value starts a new stream.

**Retention** is 30 days (`limits_config.retention_period` in `infra/loki/config.yaml`). The
compactor is the only thing that deletes, since Railway Buckets have no lifecycle rules. The lines
carry email and IP (the auth audit trail), so do not raise it without deciding that is acceptable.
The delete API is disabled, because with auth off anything on the private network could call it.

**When Loki is down or slow**, requests are unaffected: pino-loki runs in a worker thread and posts
a batch every 5 seconds. A failed batch is dropped, not retried, and those lines exist only on
stdout. Each failure also prints a multi-line `fetch failed` stack to stderr, every 5 seconds per
process, so a Loki redeploy (which has downtime: a service with a volume never runs two
deployments at once) leaves a few of these behind. A process holds at most 10,000 unsent lines,
dropping the oldest. The batch in flight when a process stops is lost, so the last few seconds of
every shutdown miss Loki. If the worker itself dies, the process prints `Loki transport failed` once
and carries on with stdout only until its next restart.

The rules in `infra/prometheus/rules/loki.yml` (`LokiDown`, `LokiPushFailing`,
`LokiDiscardingLines`, `LokiChunkFlushFailing`) show in Prometheus and Grafana, but nothing delivers
them: there is no Alertmanager or contact point. A bucket that breaks at boot fails Loki's
healthcheck; one that breaks later shows only as `LokiChunkFlushFailing`, since pushes keep landing
in memory and the WAL, and chunks flush after 30 minutes idle or 2 hours of age, so it can take
hours to appear. To recover:

1. `railway logs --service loki` — a bucket error means the `LOKI_S3_*` references are wrong;
   `no space left` means the volume is full.
2. `railway redeploy --service loki`. On restart it replays the WAL, so nothing it had
   acknowledged is lost.

To stop shipping, remove `LOKI_URL` from the three services in `.railway/railway.ts` and apply.
Each service goes back to stdout only on its next deploy.

---

## Deploy Elasticsearch

`elasticsearch` is a Railway service declared in `.railway/railway.ts`, built from `infra/elasticsearch/`,
with its data on the `elasticsearch-data` volume. It holds only the catalog search index, which is
derived from the api's Postgres ([decision record](./docs/system-architecture.md#search-index-consistency)), so losing the volume
costs a [rebuild](#rebuild-the-search-index), not data. Like the monitoring stack it is outside
`cd.yml`: a config change is `railway up --ci --service elasticsearch`. A service with a volume never
runs two deployments at once, so each redeploy takes search away for a minute or two; meanwhile
`/products/search` answers empty and catalog events retry.

What it depends on:

- **No public surface, ever.** No domain and no TCP proxy: only the private network reaches it, over
  plain HTTP. `railway domain list --service elasticsearch` prints nothing, and the service's
  Settings → Networking shows no TCP proxy.
- **HTTP binds `::`, transport only loopback** (`infra/elasticsearch/elasticsearch.yml`). Railway's
  private network is IPv6-only. The transport port runs without TLS and would trust whatever user a
  peer claimed, and a single node has no peers to talk to.
- **It starts as root only to hand the root-owned volume to uid 1000**, then drops to it
  (`railway-entrypoint.sh`). Elasticsearch refuses to run as root.
- **No healthcheck path.** With security on, Railway's unauthenticated probe would get 401, so
  readiness is checked by hand below.
- **The api signs in as `jcool_api`**, whose role `jcool_api_search` reaches `products*` and the
  cluster `monitor` privilege, nothing else. `ELASTIC_PASSWORD` never leaves this service.
  `API_SEARCH_PASSWORD` is stored here too, where the engine ignores it; the api references it as
  `SEARCH_PASSWORD`, so the two cannot drift.
- **Memory.** Heap 512 MB (`ES_JAVA_OPTS`). Measured locally, idle: about 0.95 GiB. While
  rebuilding 60k products: up to 1.15 GiB of process memory, 1.4 GiB counting page cache. The budget
  is 1.5 GB. Replace these with Railway's figures after the first release.

In the service's shell (`railway ssh --service elasticsearch`), every call signs in as `elastic` from
that container's env and every password travels through stdin, so none reaches argv, shell history
or a log:

```sh
# container (elasticsearch)
es() { curl -fsS -w '\n' -K <(printf 'user = "elastic:%s"\n' "$ELASTIC_PASSWORD") -H 'content-type: application/json' "$@"; }
# the security index answers a few seconds after the node does
until es -o /dev/null localhost:9200/_security/_authenticate 2>/dev/null; do sleep 2; done
```

### First release

The merge that adds this service also removes api variables, so CD waits at "Confirm destructive
Railway changes" before it deploys anything. Finish from an up-to-date `main`, in this order:

0. **Record the api's `SEARCH_ENABLED` and `SEARCH_URL`** from the dashboard (neither is a secret).
   Step 8 and the rollback depend on them. Step 3 deletes `SEARCH_API_KEY`: if search is on today and
   the engine it names should come back after a rollback, keep its key wherever secrets live first.
1. **Back up** the api's database ([Back up](#back-up)).
2. **Merge**, then wait until the CD run waits at "Confirm destructive Railway changes", and leave
   it waiting. Approving it, or an apply of yours that lands before CD plans, deploys the api ahead
   of the engine.
3. **Apply.**

   ```bash
   railway config plan    # api: SEARCH_API_KEY and SEARCH_HOST_PORT deleted, SEARCH_URL becomes a reference,
                          # SEARCH_USERNAME and SEARCH_PASSWORD added; elasticsearch and its volume created
   railway config apply --confirm-destructive
   ```

   The apply also redeploys the api, and its pre-deploy step applies the migrations, which the running
   code tolerates. Until step 4, `SEARCH_PASSWORD` has no value: the new code either refuses to boot
   (a blank password fails validation), so Railway keeps the running deployment, or boots unable to
   sign in, so search answers empty and catalog events retry. Either way, carry on through step 7
   within about 33 minutes, the catalog retry horizon; step 11 catches what falls past it.
4. **Set the secrets**, generated straight into Railway:

   ```bash
   openssl rand -hex 24 | tr -d '\n' | railway variable set ELASTIC_PASSWORD --stdin --service elasticsearch --skip-deploys
   openssl rand -hex 24 | tr -d '\n' | railway variable set API_SEARCH_PASSWORD --stdin --service elasticsearch --skip-deploys
   ```

5. **Deploy it:** `railway up --ci --service elasticsearch`, then wait for `started` in
   `railway logs --service elasticsearch`.
6. **Create the api's role and user** in the service's shell, after the helper above. Both calls
   answer `"created":true`.

   ```sh
   es -X PUT localhost:9200/_security/role/jcool_api_search --data-binary @- <<'EOF'
   {
     "cluster": ["monitor"],
     "indices": [
       {
         "names": ["products*"],
         "privileges": ["read", "write", "create_index", "delete_index", "manage", "view_index_metadata"]
       }
     ]
   }
   EOF

   printf '{"password":"%s","roles":["jcool_api_search"]}' "$API_SEARCH_PASSWORD" |
     es -X PUT localhost:9200/_security/user/jcool_api --data-binary @-
   ```

7. **Deploy the api:** approve the waiting CD run. The plan is now empty, so it skips the apply; the pre-deploy step applies
   the two migrations (`products.search_version`, and dropping `idx_products_active_id`), and the api
   creates `products_v0` behind the `products` alias at boot.
8. **Enable search** if step 0 found it off: `railway variable set SEARCH_ENABLED=true --service
   jcool-ecommerce-backend`, which redeploys the api.
9. **Check reachability and privilege** from the api's shell (`railway ssh --service
   jcool-ecommerce-backend`), with the `es` helper from [Rebuild the search index](#rebuild-the-search-index):

   ```sh
   es /_cluster/health            # 200, "status":"green"
   es /_security/_authenticate    # 200, "roles":["jcool_api_search"]
   es PUT /stray-index            # 403
   ```

10. **Rebuild**, once step 7's rollout has finished: `npm run search:reindex:prod` in the api's shell.
    Documents must equal the searchable products and tombstones the rest.
11. **Drain the overlap.** During the rolling deploy an old replica's worker can take a `catalog.*` job,
    find no handler for it and dead-letter it. List the catalog queue's DLQ with `npm run queue:replay-dlq:prod -- --queue api-events`. If
    it holds only `catalog.*` entries, replay them with `npm run queue:replay-dlq:prod -- --queue api-events --apply`;
    anything else is judged as in [Replay the dead-letter queue](#replay-the-dead-letter-queue) first,
    since `--apply` replays the whole queue.
12. **Verify.** Edit a product in `/admin`, then search for it: it shows within 2 s. Watch this
    service's memory for a day, one rebuild included, and write the figures into *Memory* above.

### Roll back

- **Elasticsearch will not boot, or runs out of memory:** `railway variable set SEARCH_ENABLED=false
  --service jcool-ecommerce-backend`, which redeploys the api. Search answers the empty page and
  catalog events are consumed without effect. Fix it, turn search back on, then rebuild: a rebuild is
  required after running with search off.
- **The api release misbehaves:**
  1. Take search away from the previous release before it boots, without redeploying anything yet.
     It has no engine to talk to, and it refuses a blank `SEARCH_URL`, while the current one names
     the service the revert deletes:

     ```bash
     railway variable set SEARCH_ENABLED=false --service jcool-ecommerce-backend --skip-deploys
     railway variable set 'SEARCH_URL=<the value step 0 recorded>' --service jcool-ecommerce-backend --skip-deploys
     ```

  2. Revert the merge on `main`. The revert's config removes this service, its volume,
     `SEARCH_USERNAME` and `SEARCH_PASSWORD`, so CD waits for a [destructive
     review](#review-a-destructive-change) again; check those are the only destroys and approve it.
  3. Keep both migrations: the previous release ignores `search_version`, and its active-products
     scan works without `idx_products_active_id`, only slower. `catalog.*` rows still in the outbox
     dead-letter under it; drop them. Turn search back on only for an engine that still exists and
     whose key you kept (step 0).
- **Never restore the database backup to roll back code.** It would drop every order placed since the
  backup. The backup exists for data loss, and a restore is followed by a rebuild.

### Rotate a password

**`jcool_api`.** Set a new value, which redeploys this service:

```bash
openssl rand -hex 24 | tr -d '\n' | railway variable set API_SEARCH_PASSWORD --stdin --service elasticsearch
```

Apply it in the service's shell, after the helper above, then redeploy the api so its reference picks
it up (`railway redeploy --service jcool-ecommerce-backend --yes`). Until then the api's search answers
empty and catalog events retry.

```sh
printf '{"password":"%s"}' "$API_SEARCH_PASSWORD" |
  es -X POST localhost:9200/_security/user/jcool_api/_password --data-binary @-
```

**`elastic`.** Set a new value the same way (`ELASTIC_PASSWORD`). The image seeds it as the bootstrap
password on every start, and `elastic` signs in with that for as long as no password has been stored
for it through the API, so the redeploy is usually the whole rotation. Check in the service's shell:

```sh
elastic_status() { curl -s -o /dev/null -w '%{http_code}' -K <(printf 'user = "elastic:%s"\n' "$ELASTIC_PASSWORD") localhost:9200/_security/_authenticate; }
until [ "$(elastic_status)" != 503 ]; do sleep 2; done; elastic_status; echo
```

`200` means done. `401` means a password was stored for `elastic` at some point; write the env value
over it:

```sh
printf '%s\n%s\n' "$ELASTIC_PASSWORD" "$ELASTIC_PASSWORD" |
  chroot --userspec=1000:0 --skip-chdir / elasticsearch-reset-password -u elastic -i -b --url http://localhost:9200
```

The api is unaffected either way.

---

## The id-service's etcd

`id-etcd` is a single etcd member declared in `.railway/railway.ts`, built from `infra/etcd/`, with its data on the `id-etcd-data` volume. It holds only the id-service's node owners and floors, under `/jcool/id-service/` ([how the lease works](./apps/id-service/README.md#the-node-lease)). Like Elasticsearch it is outside `cd.yml`: a config change is `railway up --ci --service id-etcd`, and as a service with a volume it never runs two deployments at once. It has no domain and no TCP proxy, and its image has no shell, so every operator action runs from an id-service replica's shell (`railway ssh --service id-service`), where `dist/lease/lift-floors-cli.js` lives.

**While it is down** the replicas keep minting until their ceiling, `ID_LEASE_TTL_MS` past their last renew, less `ID_LEASE_FENCE_MARGIN_MS`: about four minutes with the defaults. Then they turn unready and the api answers 503 on writes. They come back on their own once it answers: a restart that keeps the volume keeps every owner, and etcd restarts each lease's TTL. So a redeploy of `id-etcd`, a minute or two, mints through. The signals are `node lease renew failed; minting until the fence` in the id-service's logs and `id_lease_lost_total` for an outage that outlasted the ceiling.

### Cut over from Postgres

Production made this cut-over on 2026-10-13. The steps stay as the record of what it took and as the base for [rolling it back](#roll-back-the-cut-over).

The merge that brings etcd deletes `id-postgres`. The two stores do not see each other's leases, so no Postgres-era replica may mint once an etcd-era one does, and the etcd floors must start above every id a Postgres-era holder stamped. So the id-service is down from step 2 to step 5, about ten minutes: reads keep working and the api answers 503 on writes. Do it off-peak, from an up-to-date `main`:

1. **Merge**, then wait until the CD run waits at "Confirm destructive Railway changes": the plan deletes `id-postgres` and its volume. Leave it waiting. Approving it now, or an apply of yours that lands before CD plans, deploys the id-service ahead of etcd and with Postgres-era replicas still minting.
2. **Stop the Postgres-era replicas**: `railway down --service id-service --yes`. Each drains, releases its node and exits. Then wait `ID_LEASE_TTL_MS` (5 minutes unless set): no id was stamped past its holder's lease end, so after that the clock is above every Postgres-era id.
3. **Apply.**

   ```bash
   railway config plan    # id-postgres and its volume destroyed; id-etcd and id-etcd-data created;
                          # id-service: DATABASE_URL deleted, ETCD_ENDPOINTS added, pre-deploy changed
   railway config apply --confirm-destructive
   ```

   If the apply redeploys the id-service's last upload, that deployment fails at its pre-deploy step, since the Postgres-era image has no `lift-floors-cli.js`. That is expected: nothing mints.

4. **Deploy etcd**: `railway up --ci --service id-etcd`, then wait until the deployment is live (its healthcheck is etcd's `/health`).
5. **Deploy the rest**: approve the waiting CD run. The plan is now empty, so it skips the apply. The id-service's pre-deploy step finds a keyspace with no floors and lifts all 254 to its clock (`floors under /jcool/id-service/ lifted to …` in the deploy logs). The replicas then claim their nodes, and the api, the gateway and the user-service follow as usual.
6. **Verify.** Each of the three replicas logs `node lease acquired` with its own `nodeId`, and a write through the api (add a cart item) answers 2xx.

### Roll back the cut-over

Revert the merge on `main`. CD waits for review again, this time to delete `id-etcd` and its volume; leave it waiting. Repeat steps 2 and 3 (stop, wait `ID_LEASE_TTL_MS`, plan, apply), then approve the waiting run. The Postgres-era pre-deploy migrates the new, empty `id-postgres`, and its replicas start above every etcd-era id because of the wait. Skipping the wait is what makes duplicate ids possible: a fresh `id-postgres` knows no floor.

### The keyspace is lost

Nothing backs `id-etcd` up, and nothing should: its floors are rebuilt from the clock. Never restore a snapshot into it either, since its marker would let the replicas claim against floors older than ids minted since it was taken. If that happened, stop the replicas at once and replace the volume.

A new volume, or a keyspace wiped by hand, has no `initialized` marker, and the replicas refuse to claim on it. Their renews find no owner, so each stops minting at its next renew, and every acquire then fails with `etcd keyspace /jcool/id-service/ has no floors recorded; run the floor lift before any replica mints`. Readiness stays false and the api answers 503 on writes until:

1. **Wait `ID_LEASE_TTL_MS`** from the moment etcd came back empty. A replica that could not reach it since may still be minting on its old node, up to its ceiling, and the lift would hand that node to another replica below it.
2. **Lift the floors** from a replica's shell: `node dist/lease/lift-floors-cli.js`. It refuses while any node is held, writes the marker last, and the replicas claim within a second of it.

With the replicas stopped (`railway down --service id-service --yes`) the wait still applies, and the next deploy's pre-deploy step does the lift.

---

## Operate Temporal

`temporal` is a single Temporal server declared in `.railway/railway.ts`, built from `infra/temporal/` (`temporalio/server:1.32.1` plus the CLI and schema tools of `temporalio/admin-tools:1.32.1`). Its histories and visibility live in the `temporal-postgres` database, in the `temporal` and `temporal_visibility` databases. The order-service's `CheckoutSagaWorker` polls the task queue `checkout-saga` in the namespace `jcool`, with an identity of `order-service@<hostname>:<pid>`; the api polled the same queue before the [checkout cut-over](#cut-checkout-over-to-the-order-service) and runs no worker now. Every checkout starts a saga there ([The checkout saga](#the-checkout-saga)).

Like etcd and Elasticsearch it is outside `cd.yml` and has no repo source. A change to `infra/temporal/` deploys from the repo root with `railway up --ci --service temporal`, then `scripts/railway-wait-for-rollout.sh temporal`.

What it depends on:

- **No public surface, ever.** The frontend speaks gRPC on 7233 with no auth and no TLS: anything on the private network can start, signal or terminate a workflow. So: no domain and no TCP proxy. The frontend's HTTP API (7243) is left out of the server config (`infra/temporal/config/config_template.yaml`), and `netstat -ltn` in the container must never list 7243. There is no healthcheck path either, because Railway's probe is HTTP.
- **The entrypoint does the bootstrap** (`infra/temporal/entrypoint.sh`) on every boot, and each step is safe to repeat. It creates both databases, sets up and updates their schema, creates the namespace or resets its retention to `TEMPORAL_NAMESPACE_RETENTION` (7d), and creates the search attributes `CheckoutStep` (Keyword) and `CheckoutDeadlineAt` (Datetime). Each step has a time limit, and a failed step exits 1 so Railway restarts the container. A good boot logs `temporal-bootstrap: schema ready`, then `temporal-bootstrap: namespace jcool ready (retention 7d)`.
- **It binds `::`.** Railway's private network is IPv6-only. The server refuses a wildcard bind without a broadcast address, so the entrypoint takes the first address of `hostname -i`.
- **`NUM_HISTORY_SHARDS` is 4 for the life of `temporal-postgres`.** The first boot records it in the database. Another value needs a new, empty database: drain first (below).
- **Upgrades go one minor version at a time.** Bump `temporalio/server` and `temporalio/admin-tools` together in `infra/temporal/Dockerfile`, and back up first: the boot runs `update-schema`. Then compare the image's embedded config template with `config_template.yaml`, which is a copy of it without the frontend's `httpPort`.

### Check it

In the service's shell (`railway ssh --service temporal`):

```sh
# container (temporal); `::` also accepts 127.0.0.1
t() { temporal --address 127.0.0.1:7233 "$@"; }
t operator cluster health                                                  # SERVING
t operator cluster describe --detail                                       # history shard count (4) and server version
hostname -i                                                                # its first address is the one the cluster advertises
t operator namespace describe --namespace jcool                            # WorkflowExecutionRetentionTtl 168h0m0s
t operator search-attribute list --namespace jcool                         # CheckoutStep Keyword, CheckoutDeadlineAt Datetime
t task-queue describe --task-queue checkout-saga --namespace jcool         # the order-service's pollers, workflow and activity
t workflow count --namespace jcool --query 'ExecutionStatus="Running"'
netstat -ltn                                                               # 7233 and the cluster's own ports; never 7243
```

The image has busybox `netstat`, not `ss`.

### Back up `temporal-postgres`

It holds every open saga. Back it up before an upgrade, and before anything that replaces the database. Run [Back up](#back-up) twice against the database's connection URL (Variables tab of `temporal-postgres`), with the path set to `/temporal` and then to `/temporal_visibility`. A restore rewinds every open run to the dump, while the stock and payment headers have moved on since. So right after a restore, check each running saga's headers as in [Temporal down](#temporal-down).

### Changing the workflow while runs are open

A run replays its history on every worker that picks it up, so a change to `checkout-saga.workflow.ts` or to anything it imports must stay deterministic for the histories already recorded. `checkout-saga.replay.spec.ts` replays the ones in `replay-histories/` in the unit suite, and a change that breaks it would break every open run. To keep such a change:

- **guard the new branch with `patched('<change-name>')`**, so old runs keep their old path; or
- **drain first**: [freeze checkout](#freeze-checkout), wait for the running count above to reach 0, deploy, then unfreeze. A saga lives up to `CHECKOUT_PAYMENT_DEADLINE_SEC` + `SAGA_AUTH_GRACE_SEC` (about an hour), longer while a compensation keeps failing.

Then record the histories again, so the next change is checked against this one: `CHECKOUT_SAGA_HISTORY_OUT=src/modules/order/infrastructure/temporal/replay-histories pnpm -C apps/order-service test:e2e checkout-saga-workflow`.

### The shutdown budget

The order-service holds the worker, so after SIGTERM it runs these steps on its `ShutdownService`, in order: readiness goes down, then it holds for `SHUTDOWN_GRACE_PERIOD_MS`, drains the Temporal worker (`TEMPORAL_WORKER_SHUTDOWN_GRACE_MS` + `TEMPORAL_WORKER_SHUTDOWN_FORCE_MS` + 1000), closes the `order-events` worker (two waits of 5000), and closes the Temporal client, the `NativeConnection` and the pools last. Those steps must end at least a second before its `drainingSeconds`: 5000 + 4000 + 4000 + 1000 + 2 × 5000 = 24000 ≤ 30 × 1000 − 1000. Raise `drainingSeconds` in `.railway/railway.ts` in the same change that raises any of those three variables. Past it, Railway kills the process mid-drain, and the BullMQ jobs it held stay active until stalled-job recovery picks them up. A `NativeConnection` that fails to close after a forced worker shutdown is only logged.

The api has no worker now: readiness, the hold, the `api-events` worker and the pools, 5000 + 5000 + 1000 = 11000. Its `drainingSeconds` stays 30 because a rollback of the checkout cut-over puts the worker back in it, at 25000.

Two waits sit outside the steps and are not in that sum. Before them, the outbox relay waits up to 5000 for an open tick to commit. After them, the telemetry flush waits up to 3000, and then the Redis and pg pools close; the pg close also waits for a connection that an activity abandoned at the force deadline still holds, which only the participant's own timeouts (`PAYMENT_CAPTURE_TIMEOUT_MS` per gateway call) bound. When every bounded wait runs to its limit, the total is 33000, which is past the 30000 that `drainingSeconds` allows. That only happens when Postgres or Redis hangs during the deploy. The kill then lands in the telemetry flush, so the spans from the drain window are lost; an open transaction is rolled back with its connection, as with any kill.

---

## The checkout saga

Every order past `DRAFT` has one workflow, `checkout-<order id>` (a `RESERVING` order whose start never reached Temporal gets it from the reaper), and that workflow is the only writer of the order's status ([decision record](./docs/system-architecture.md#checkout-saga-orchestration-on-temporal-tcc-on-stock-and-payment)). The order row says what the buyer sees; the workflow says where the saga is.

### Read a saga

```sh
# container (temporal), with t() from Check it
t workflow list --namespace jcool --query 'WorkflowId="checkout-<order id>"'       # Running, Completed, Terminated, ... (describe leaves it out while running)
t workflow describe --namespace jcool --workflow-id checkout-<order id>            # CheckoutStep, pending activities and their last failure
t workflow query --namespace jcool --workflow-id checkout-<order id> --name state  # step, order status, Try outcome, authorization
for s in RESERVING AWAITING_AUTH COMMITTING_STOCK CAPTURING COMPENSATING; do
  echo "$s $(t workflow count --namespace jcool --query "CheckoutStep=\"$s\" AND ExecutionStatus=\"Running\"")"
done
```

| `CheckoutStep` | Order | Means |
| --- | --- | --- |
| `RESERVING` | `RESERVING` | The stock Try or tx B is running |
| `AWAITING_AUTH` | `PENDING` | Stock held; waiting for `payment.authorized` or the payment deadline |
| `COMMITTING_STOCK`, `CAPTURING` | `CONFIRMING` | Authorization verified; stock commit, then the capture |
| `COMPENSATING` | terminal | Releasing stock or voiding the hold. An activity failing here retries without limit; `describe` shows the last failure |

A run that stays in one step is almost always an activity retrying against a participant, the inventory-service or the payment-service. Fix what it is failing on; the run then moves by itself.

### Checkout answers 503 and the order stays `RESERVING`

tx B mints its outbox id before it opens, so an id-service or database outage makes it throw. The local activity retries it with backoff (`SAGA_RETRY_BASE_MS` to `SAGA_RETRY_CAP_MS`) while the buyer gets `503` after `CHECKOUT_RESERVE_WAIT_MS`. The order stays `RESERVING`, hidden from the buyer, with its stock `HELD`. Once the dependency is back, tx B commits: the order turns `PENDING` with exactly one `order.placed`, and a retry under the same `Idempotency-Key` answers `201` with that order.

The order lives in `order-postgres` and its hold in `inventory-postgres`, so read the two apart:

```sql
-- order-postgres
SELECT id, placed_at FROM orders WHERE status = 'RESERVING' ORDER BY placed_at;
-- inventory-postgres, with those ids
SELECT order_id, status, hold_until FROM reservation_orders WHERE order_id IN ('<order id>', …);
```

A `RESERVING` order with no hold and no workflow is one whose start never reached Temporal. The reaper hands it back to its saga once it is older than `CHECKOUT_RESERVING_ORPHAN_SEC`, every `CHECKOUT_REAPER_INTERVAL_MS`, and the saga rejects it because its Try budget is long spent. A reaper tick stops at the first order the engine cannot take, so a Temporal outage costs one failed call per tick.

The reaper cannot hand back an order whose run has already closed, which only a terminated or timed-out run leaves behind. It logs `RESERVING order whose checkout saga has already closed` at error on every tick and moves on; the order keeps one of the buyer's three checkout slots, and fifty of them fill the reaper's batch so newer orphans wait. Close it by hand as in [Terminate a saga](#terminate-a-saga): clean up its inventory header first (in `inventory-postgres`), then, in `order-postgres`, `UPDATE orders SET status = 'REJECTED', finalized_at = now(), finalize_reason = 'ops:closed_saga' WHERE id = '<order id>' AND status = 'RESERVING';`.

### A `payment.authorized` in the dead-letter queue

Its consumer signals the order's saga, so the job rides the long ladder (`ORDER_PAID_CONSUMER_*`, about 33 minutes) to outlast a Temporal outage. The payment-service stamps the attempts when it publishes the job, so its `ORDER_PAID_CONSUMER_ATTEMPTS` must equal the order-service's ([Cross-service settings](#cross-service-settings)). Past the ladder it dead-letters into `order-events-dlq`. Once Temporal answers, replay it with `pnpm queue:replay-dlq:order --queue order-events` ([Dead-letter queues](#dead-letter-queues)): the saga takes one authorization per order and captures once, and an authorization arriving after the order closed is voided, not captured.

### Terminate a saga

Only as in [Temporal down](#temporal-down): once Temporal answers, for a run that cannot finish by itself, and only after both participant headers have been cleaned up by hand. The terminated run then holds [CheckoutSagaClosedAbnormally](#checkoutsagaclosedabnormally) firing for an hour; that one is expected.

### Settle a payment by hand

Only for an order with no running run ([Read a saga](#read-a-saga)). A void or capture made in the Stripe dashboard never reaches the database: the webhook handles only `checkout.session.*` events, so the payment rows keep reading `AUTHORIZED`, and the alerts and the invariant checker that read them keep firing. Settle it through the rows instead, which are the payment-service's, in `payment-postgres`:

- **Void.** Cancel the header and let the reconcile sweep call Stripe: `UPDATE payment_orders SET status = 'CANCELLED' WHERE order_id = '<order id>' AND status IN ('OPEN', 'AUTHORIZED');`. Once the attempt is `ORDER_STALE_THRESHOLD_SEC` (120) old, the next `RECONCILE_INTERVAL_MS` tick voids its PaymentIntent and records the attempt `VOIDED`. `RECONCILE_ENABLED` must not be `false` on the payment-service.
- **Capture**, only for a `PAID` order. Capture the PaymentIntent in the Stripe dashboard, then record what the participant's own capture writes: `UPDATE payments SET status = 'SUCCEEDED', updated_at = now() WHERE order_id = '<order id>' AND status = 'AUTHORIZED'; UPDATE payment_orders SET status = 'CAPTURED' WHERE order_id = '<order id>' AND status = 'AUTHORIZED';`.

Note down the order id and the PaymentIntent either way.

### Its alerts

The saga's alerts are in `infra/prometheus/rules/checkout-saga.yml`, the queue's in `messaging.yml`, and `ApiScrapeDown`, `OrderScrapeDown`, `InventoryScrapeDown` and `PaymentScrapeDown` in `scrape-targets.yml`. Each alert's description names its subsection below. Nothing routes alerts anywhere yet, so read the firing ones in Grafana Explore with `ALERTS{alertstate="firing"}`, or with `wget -qO- localhost:9090/api/v1/alerts` in the Prometheus container.

Prometheus never scrapes Temporal. The order-service (`job="jcool-order"`) reads every saga gauge from Temporal while it answers `/metrics`, within 2s, and reports `checkout_saga_engine_up`: 1 when every read answered, else 0, with the other saga gauges withdrawn rather than held. The checker's series come from the order-service too. Each queue's gauges come from its consumer (`order-events` from the order-service, `api-events` from the api) and `payment_authorized_uncaptured_oldest_seconds` from the payment-service's Postgres; each keeps its last value when a read fails.

The order-service's readiness includes Temporal ([Temporal down](#temporal-down)), but Railway only reads it at deploy: a running order-service keeps serving while Temporal is gone, and the gateway never probes it. So between deploys `CheckoutSagaEngineDown` and `CheckoutSagaWorkerStalled` are the only signals for it.

The commands below run in the Temporal container, with `t()` from [Check it](#check-it) and these two:

```sh
# container (temporal); busybox date, so the time goes through the epoch
ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }
RUNS='WorkflowType="CheckoutSaga" AND TaskQueue="checkout-saga"'
```

#### CheckoutSagaStuck

`checkout_saga_overdue` counts the runs still `Running` whose `CheckoutDeadlineAt` passed more than `SAGA_OVERDUE_GRACE_SEC` (300) ago. The deadline timer ends every saga on time, so each of these is held up by an activity that keeps failing (a participant, a compensation conflict) or by a workflow task that keeps failing, as a nondeterminism error after a deploy does. Their stock stays held and their payment may stay authorized meanwhile.

```sh
t workflow list --namespace jcool --query "$RUNS AND ExecutionStatus=\"Running\" AND CheckoutDeadlineAt < \"$(ago 300)\""
t workflow describe --namespace jcool --workflow-id checkout-<order id>   # the pending activity, its attempts and last failure
t workflow show --namespace jcool --workflow-id checkout-<order id>       # a WorkflowTaskFailed near the end is the workflow code itself
```

An activity failing: fix what it fails on, and the run moves by itself. A conflict is [CheckoutCompensationConflict](#checkoutcompensationconflict). A workflow task failing after a deploy: roll the deploy back, or ship the change behind `patched()` ([Changing the workflow while runs are open](#changing-the-workflow-while-runs-are-open)). Terminate only as in [Terminate a saga](#terminate-a-saga).

#### CheckoutSagaWorkerStalled

Temporal answers, but checkout tasks are not being picked up: for 5 minutes the task queue has had no poller for workflow or for activity tasks, or a task has waited over 2 minutes. A deploy reads 0 pollers while the order-service restarts, which the 5 minutes cover. Between deploys this alert and [CheckoutSagaEngineDown](#checkoutsagaenginedown) are the only Temporal signals, since Railway reads the order-service's readiness only at deploy.

```sh
t task-queue describe --task-queue checkout-saga --namespace jcool   # pollers per task type, their identity, and when each last polled
```

- **No poller.** The order-service's worker is not running. Check `TEMPORAL_WORKER_ENABLED` on the order-service, and its logs for `checkout saga worker unavailable; retrying with backoff` or `checkout saga worker cannot start without its bundle`. A poller whose identity is not `order-service@…` is a stray worker on the same queue, such as an order-service still deployed after a [rollback](#roll-back-the-checkout-cut-over).
- **Pollers, and a backlog.** The worker runs but its slots are full: activities hung on a participant (`describe` a few running sagas, as in [CheckoutSagaStuck](#checkoutsagastuck)), or more load than `SAGA_ACTIVITY_CONCURRENCY` allows.

What it stops, and how to freeze checkout meanwhile: [Temporal down](#temporal-down).

#### CheckoutSagaEngineDown

`checkout_saga_engine_up` has read 0 for 2 minutes: the order-service's reads from Temporal have not all answered within 2s. It logs `checkout saga scrape failed, saga gauges withdrawn` at most once a minute, with the error. Every other saga gauge is withdrawn meanwhile, the pollers included, so [CheckoutSagaStuck](#checkoutsagastuck), [CheckoutSagaWorkerStalled](#checkoutsagaworkerstalled) and the rest are blind until it clears. Its `/health/ready` reads Temporal too, so the next deploy of it stops at the healthcheck; the api, the gateway and a freeze are unaffected.

`t operator cluster health` in the Temporal container, and the error in that log line, tell the cases apart:

- **Anything but `SERVING`.** Temporal is down: checkout answers `503` and no saga moves. [Temporal down](#temporal-down) has the rest of the procedure.
- **`SERVING`, and the error is a connection failure (`UNAVAILABLE`).** The order-service cannot reach a healthy server: check its `TEMPORAL_ADDRESS`, and that Temporal still binds its private address ([Operate Temporal](#operate-temporal)).
- **`SERVING`, and the error is `DEADLINE_EXCEEDED` on a count.** Visibility is slow: checkout still works, only the saga alerts are blind. Time `t workflow count --namespace jcool --query "$RUNS"` in the container; a count that takes seconds is the `temporal_visibility` database on `temporal-postgres`.

#### CheckoutSagaClosedAbnormally

The saga only ever completes. A run of the checkout task queue closed as `Failed`, `Terminated`, `TimedOut` or `Canceled` is a bug or an operator, and it stopped where it was, with no compensation. The gauge counts the last hour, so the alert keeps firing for an hour after a single closure.

```sh
t workflow list --namespace jcool --query "$RUNS AND ExecutionStatus IN (\"Failed\",\"Terminated\",\"TimedOut\",\"Canceled\") AND CloseTime > \"$(ago 3600)\""
t workflow show --namespace jcool --workflow-id checkout-<order id>   # how it closed: the failure, or who terminated it and why
```

For each one, read the order and both headers with the query in [Temporal down](#temporal-down):

- **Order already terminal.** The invariant checker judges it once it settles ([CheckoutInvariantViolation](#checkoutinvariantviolation)).
- **Order `PENDING` or `CONFIRMING`, stock `COMMITTED` and payment `CAPTURED`.** The buyer has paid, but `order.paid` and its consumers never ran. Do not cancel it; escalate.
- **Order `PENDING` or `CONFIRMING` otherwise.** Nothing will move it again. Void its payment as in [Settle a payment by hand](#settle-a-payment-by-hand), or treat a captured one as [a refund owed](#a-refund-is-owed). A `HELD` stock row is released by the lapsed-hold sweep. Then close the order: `UPDATE orders SET status = 'CANCELLED', finalized_at = now(), finalize_reason = 'ops:closed_saga' WHERE id = '<order id>' AND status IN ('PENDING', 'CONFIRMING');`.

A `Failed` run is a bug in the workflow: fix it before the next checkout trips over it.

#### CheckoutCompensationConflict

A compensation found its participant in a state it cannot undo: `release_stock` or `restock` on stock already committed, or `cancel_payment` on money already captured. The activity logs `saga participant conflict; retrying until resolved by hand` at error, with the order id, and retries without limit. The run stays `COMPENSATING` and becomes [CheckoutSagaStuck](#checkoutsagastuck) once its deadline passes.

Read the order and both headers ([Temporal down](#temporal-down)) and decide which side is right. Put the participant right by hand (captured money is [a refund owed](#a-refund-is-owed); committed stock goes back on hand), note what you did, then terminate the run as in [Terminate a saga](#terminate-a-saga). Its retry would conflict forever otherwise. Neither fix changes the rows the invariant checker reads, so it keeps reporting the order until it leaves the checker's window ([CheckoutInvariantViolation](#checkoutinvariantviolation)).

#### PaymentAuthorizationUncaptured

The oldest `AUTHORIZED` payment header is over 15 minutes old. The saga captures within seconds of an authorization reaching it and voids the hold when it gives up, so this money is held on a card and nothing is settling it. Stripe voids an authorization on its own after 7 days.

The gauge is recorded by the payment-service, so the rows are in `payment-postgres`; the orders are in `order-postgres`:

```sql
-- payment-postgres
SELECT order_id, authorized_at FROM payment_orders WHERE status = 'AUTHORIZED' ORDER BY authorized_at LIMIT 20;
-- order-postgres, with those ids
SELECT id, status, payment_deadline_at FROM orders WHERE id IN ('<order id>', …);
```

Then [read each saga](#read-a-saga):

- **Order `PENDING`, run in `AWAITING_AUTH`.** The authorization has not reached the saga: see [MessagingQueueConsumerLagging](#messagingqueueconsumerlagging), or its job is in the dead-letter queue ([A `payment.authorized` in the dead-letter queue](#a-paymentauthorized-in-the-dead-letter-queue)).
- **Order `CONFIRMING`, run in `CAPTURING`.** The capture keeps failing at the gateway; `describe` shows why.
- **No running run.** Nothing will settle it. [Settle it by hand](#settle-a-payment-by-hand): capture if the order is `PAID`, void otherwise.

#### CheckoutInvariantViolation

Every `CHECKOUT_INVARIANT_INTERVAL_MS`, the checker reads the saga orders that settled between `CHECKOUT_INVARIANT_WINDOW_SEC` and `CHECKOUT_INVARIANT_SETTLE_SEC` ago, never before `CHECKOUT_INVARIANT_NOT_BEFORE`. It skips any whose run is still `Running`, and asks both participants how they stand. It fixes nothing. Each broken order is logged at error as `checkout invariant violated`, with `orderId`, `kind` and `status`, on every run. The gauge is the count from the last complete run. It clears once the rows the checker reads agree again, or once the order leaves the window. A fix made outside those rows, such as a refund or a stock correction, leaves its kind firing for up to `CHECKOUT_INVARIANT_WINDOW_SEC` (24h), and a second order of the same kind goes unseen behind it meanwhile: check the error log for new order ids.

| `kind` | Means | Put it right |
| --- | --- | --- |
| `captured_without_paid` | Money taken on an order that is not `PAID` | [A refund is owed](#a-refund-is-owed); the kind stays until the window passes |
| `paid_without_capture` | `PAID`, but the payment header is not `CAPTURED` | If the PaymentIntent still reads `requires_capture` in Stripe, capture it as in [Settle a payment by hand](#settle-a-payment-by-hand) |
| `paid_without_commit` | `PAID`, but the stock was never committed | The goods are sold but still counted on hand: correct the variant's stock by hand (`POST /admin/inventory/:variantId/adjust`, served by the inventory-service); the kind stays until the window passes |
| `orphan_hold` | Not `PAID`, and the stock is still `HELD` | The lapsed-hold sweep releases it once `hold_until` passes; one held past that is the sweep failing |
| `authorized_on_dead_order` | Not `PAID`, and a payment attempt still holds money | Under a `CANCELLED` or `FENCED` header the payment-service's reconcile sweep voids it within a few minutes, so one seen here means that sweep is off or failing. Under any other header, void it as in [Settle a payment by hand](#settle-a-payment-by-hand) |

The same kind on several orders is a defect, not bad luck. Compare with the run's history (`t workflow show`), which retention keeps for longer than the checker looks back ([Retention and the checker window](#retention-and-the-checker-window)).

#### CheckoutInvariantCheckerSilent

The order-service is being scraped, but no checker run has finished as `ok` or `violations` for 30 minutes, so a broken order would go unnoticed. The order-service's logs say why:

- **`checkout invariant checker disabled`** at boot: `CHECKOUT_INVARIANT_ENABLED` is false.
- **`checkout invariant check failed, gauges left as they were`** at warn, on every run, with the error: a participant or Temporal is not answering, and `checkout_invariant_check_total{result="error"}` climbs. With [CheckoutSagaEngineDown](#checkoutsagaenginedown) firing too, Temporal is the cause; with [InventoryScrapeDown](#inventoryscrapedown) or an open `inventory-service` breaker, the stock side's `POST /internal/v1/reservations/status` is; with [PaymentScrapeDown](#paymentscrapedown) or an open `payment-service` breaker, the payment side's `POST /internal/v1/payments/status` is.
- **`previous invariant check still running, tick skipped`**: one run outlasts `CHECKOUT_INVARIANT_INTERVAL_MS`.
- **None of these**: the scheduler never started; look for `checkout invariant checker scheduled` at boot.

#### CheckoutLateAuthorization

A payment was authorized after its saga had ended, and a `lateAuthorization` run voided it. Each one is handled, and costs the buyer only the wait for the void. A steady stream means authorizations arrive later than `CHECKOUT_PAYMENT_DEADLINE_SEC` + `SAGA_AUTH_GRACE_SEC` allows, or after a cancel: the queue lags ([MessagingQueueConsumerLagging](#messagingqueueconsumerlagging)), or buyers pay on sessions that outlive their order.

```sql
-- payment-postgres
SELECT order_id, status, authorized_at FROM payment_orders
WHERE authorized_at IS NOT NULL ORDER BY authorized_at DESC LIMIT 20;
-- order-postgres, with those ids: an order not PAID, finalized before its authorization, is a late one
SELECT id, status, finalized_at, finalize_reason FROM orders WHERE id IN ('<order id>', …) AND status <> 'PAID';
```

#### MessagingQueueConsumerLagging

The oldest job waiting on a queue (the alert's `queue` label) has waited over a minute, for 5 minutes. On `order-events` that holds back `payment.authorized` on its way to the saga, so paid checkouts run into their deadline and compensate; on `api-events` it is search that lags behind catalog writes. Nothing else shows it: the relays keep publishing, so the outboxes stay young and the DLQs stay empty. `messaging_queue_jobs{queue,state}` tells the cases apart:

- **`active` at 0.** No consumer: that queue's BullMQ worker is not running (`QUEUE_WORKER_ENABLED` on its consumer, the order-service for `order-events` and the api for `api-events`) or cannot reach Redis.
- **`active` steady and `wait` growing.** The consumer is saturated or a handler is slow; the handler's logs show what it waits on.

#### Saga metrics absent

`CheckoutSagaMetricsAbsent`, `PaymentMetricsAbsent` and `MessagingQueueMetricsAbsent` mean the service that owns a series is being scraped but its `/metrics` lacks it, so the alerts built on it cannot fire. The saga series and the `order-events` gauge come from the order-service and join its `up`; the `api-events` gauge comes from the api and joins the api's (`MessagingQueueMetricsAbsent` has one branch per queue, told apart by the `queue` label); `payment_authorized_uncaptured_oldest_seconds` comes from the payment-service, and `PaymentMetricsAbsent` joins that service's `up`. Each collector is a provider of its module and only reports from the process that owns the metrics registry. A series goes missing when that module is not in the app that serves `/metrics`, for example after it moved to another service. `observability-metrics.e2e-spec.ts` fails, in each of the three, on a build that drops one, so first check which build is deployed, then what the service serves:

```sh
# container (prometheus)
wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" "http://$ORDER_TARGET/metrics" \
  | grep -E '^(checkout_saga_engine_up|messaging_queue_oldest_waiting_seconds)'
wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" "http://$API_TARGET/metrics" \
  | grep -E '^messaging_queue_oldest_waiting_seconds'
wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" "http://$PAYMENT_TARGET/metrics" \
  | grep -E '^payment_authorized_uncaptured_oldest_seconds'
```

#### ApiScrapeDown

Prometheus has not scraped the api for 5 minutes, so every api alert, the absent-metrics ones included, is blind. Prometheus has no domain; its target page answers inside its container:

```sh
# container (prometheus)
wget -qO- localhost:9090/api/v1/targets | grep -o '"lastError":"[^"]*"'
```

- **Connection refused, or a timeout.** The api is down or restarting (its deploy logs), or the private network cannot reach it; `API_TARGET` on `prometheus` must name the api's private domain and port.
- **404.** `/metrics` answers 404 both when the api has no `METRICS_TOKEN` and when the token Prometheus sends is not the api's. Set the same value on both services ([Deploy the monitoring stack](#deploy-the-monitoring-stack)), then redeploy the one that changed.

#### InventoryScrapeDown

Prometheus has not scraped the inventory-service (`job="jcool-inventory"`) for 5 minutes. Its own metrics are blind, and if it is down rather than unreachable from Prometheus, checkout is stopped too: the order-service's Try fails and checkout answers `503` with `Retry-After`, and once `BREAKER_ERROR_THRESHOLD_PCT` of the calls in the breaker's window have failed (with at least `BREAKER_VOLUME_THRESHOLD` made), the `inventory-service` breaker opens, `CircuitBreakerOpen{breaker="inventory-service"}` fires, and the order-service stops calling it until `BREAKER_RESET_TIMEOUT_MS` lets one through. Sagas past their Try wait in `COMMITTING_STOCK` or `COMPENSATING`, retrying, and move by themselves once it answers. Read the target the same way as for [ApiScrapeDown](#apiscrapedown):

```sh
# container (prometheus)
wget -qO- localhost:9090/api/v1/targets | grep -o '"scrapeUrl":"[^"]*inventory[^"]*"\|"lastError":"[^"]*"'
```

- **Connection refused, or a timeout.** Check the inventory-service's deploy logs and `/health/ready` from inside it (`railway ssh --service inventory-service`, then `node -e "fetch('http://127.0.0.1:3000/health/ready').then(r => r.text()).then(console.log)"`): `503` names Postgres, Redis or a drain. A crash at boot logs why, typically no caller token at all or an unreachable `inventory-postgres`. `INVENTORY_TARGET` on `prometheus` must name its private domain and port.
- **404.** The inventory-service has no `METRICS_TOKEN`, or another one than the api's: it references the api's in `.railway/railway.ts`, so a redeploy of it picks the current value up.
- **Checkouts fail while the target is up.** Not this alert: the order-service's calls are refused. A `401` or `403` in the order-service's logs for `/internal/v1/reservations` is a token out of step ([Per-caller internal tokens](#per-caller-internal-tokens)).

While it is down, [freeze checkout](#freeze-checkout) if buyers should get the gateway's `503` instead of a wait.

#### PaymentScrapeDown

Prometheus has not scraped the payment-service (`job="jcool-payment"`) for 5 minutes. Its own metrics are blind, `payment_authorized_uncaptured_oldest_seconds` included, so `PaymentAuthorizationUncaptured` cannot fire; and if it is down rather than unreachable from Prometheus, payments are stopped too. `/pay` answers `502`, and once `BREAKER_ERROR_THRESHOLD_PCT` of the calls in the breaker's window have failed (with at least `BREAKER_VOLUME_THRESHOLD` made), the `payment-service` breaker opens, `CircuitBreakerOpen{breaker="payment-service"}` fires, and the order-service stops calling it until `BREAKER_RESET_TIMEOUT_MS` lets one through. Sagas past their authorization wait in `CAPTURING` or `COMPENSATING`, retrying, and move by themselves once it answers. Stripe's webhook cannot reach it either, so Stripe redelivers on its own schedule, and the reconcile sweep records any authorization the webhook missed once the service is back. Read the target the same way as for [ApiScrapeDown](#apiscrapedown):

```sh
# container (prometheus)
wget -qO- localhost:9090/api/v1/targets | grep -o '"scrapeUrl":"[^"]*payment[^"]*"\|"lastError":"[^"]*"'
```

- **Connection refused, or a timeout.** Check the payment-service's deploy logs and `/health/ready` from inside it (`railway ssh --service payment-service`, then `node -e "fetch('http://127.0.0.1:3000/health/ready').then(r => r.text()).then(console.log)"`): `503` names Postgres, Redis or a drain. A crash at boot logs why, typically no caller token at all, a missing `STRIPE_SECRET_KEY` or `STRIPE_SUCCESS_URL` (production refuses to boot without them), or an unreachable `payment-postgres`. `PAYMENT_TARGET` on `prometheus` must name its private domain and port.
- **404.** The payment-service has no `METRICS_TOKEN`, or another one than the api's: it references the api's in `.railway/railway.ts`, so a redeploy of it picks the current value up.
- **Payment calls fail while the target is up.** Not this alert: the order-service's calls are refused. A `401` or `403` in the order-service's logs for `/internal/v1/payments` is a token out of step ([Per-caller internal tokens](#per-caller-internal-tokens)).

While it is down, [freeze checkout](#freeze-checkout) if buyers should get the gateway's `503` instead of a wait.

#### OrderScrapeDown

Prometheus has not scraped the order-service (`job="jcool-order"`) for 5 minutes. Every saga, checker and `order-events` alert reads its series, and their absent-metrics alerts join its `up`, so all of them are blind and silent until it is scraped again. If it is down rather than unreachable from Prometheus, checkout is stopped too: the gateway's `/orders*` routes answer `502`, no saga moves (open runs wait in Temporal and resume once a worker polls again), and `payment.authorized` jobs wait on the long ladder. Read the target the same way as for [ApiScrapeDown](#apiscrapedown):

```sh
# container (prometheus)
wget -qO- localhost:9090/api/v1/targets | grep -o '"scrapeUrl":"[^"]*order[^"]*"\|"lastError":"[^"]*"'
```

- **Connection refused, or a timeout.** Check the order-service's deploy logs and `/health/ready` from inside it (`railway ssh --service order-service`, then `node -e "fetch('http://127.0.0.1:3000/health/ready').then(r => r.text()).then(console.log)"`): `503` names Postgres, Redis, Temporal or a drain. A crash at boot logs why, typically a `*_SERVICE_TOKEN` whose callee variable is unset (each is a reference, at least 32 characters), a missing `TEMPORAL_*` in production, or an unreachable `order-postgres`. `ORDER_TARGET` on `prometheus` must name its private domain and port.
- **404.** The order-service has no `METRICS_TOKEN`, or another one than the api's: it references the api's in `.railway/railway.ts`, so a redeploy of it picks the current value up.
- **Expected after a rollback** of the [checkout cut-over](#cut-checkout-over-to-the-order-service), until the forward fix: the order-service is taken down then, and the saga is watched through the api's `checkout_sagas_open` meanwhile.

While it is down, [freeze checkout](#freeze-checkout) if buyers should get the gateway's `503` instead of a `502`.

### Retention and the checker window

`TEMPORAL_NAMESPACE_RETENTION` on `temporal` (7d) must stay above `CHECKOUT_INVARIANT_WINDOW_SEC` on the order-service (86400), which in turn must stay above `CHECKOUT_INVARIANT_SETTLE_SEC`. The order-service checks the second rule at boot. The first spans two services, so nothing checks it: keep it in mind when changing either. A shorter retention deletes a closed run's history while the checker can still flag its order, and the investigation loses its best evidence.

### `CHECKOUT_INVARIANT_NOT_BEFORE`

Unset, except around a cut-over that moves a participant into its own service, and that cut-over's rollback. Orders settled before the move keep their headers in the old database, where the new `statusOf` cannot see them, so each one would read as a violation. Set it to the UTC time the drain finished, and unset it once `CHECKOUT_INVARIANT_WINDOW_SEC` has passed. The checker runs in the order-service, so that is where it is set; each change redeploys it. The api keeps a value of its own only for a rollback build whose checker runs there again.

```bash
railway variable set "CHECKOUT_INVARIANT_NOT_BEFORE=<drain end, e.g. 2026-11-02T09:30:00Z>" --service order-service
railway variable delete CHECKOUT_INVARIANT_NOT_BEFORE --service order-service
```

The [checkout cut-over](#cut-checkout-over-to-the-order-service) needs none: `order-postgres` starts empty, so no order there settled under an older topology.

---

## Temporal down

**How it shows.**

- The order-service logs `checkout saga worker unavailable; retrying with backoff` at most once a minute, with the error and the address.
- If the image lacks the workflow bundle, it logs `checkout saga worker cannot start without its bundle` instead.
- `task-queue describe` ([Check it](#check-it)) lists no poller from the order-service.
- [CheckoutSagaEngineDown](#checkoutsagaenginedown) pages after 2 minutes; [CheckoutSagaWorkerStalled](#checkoutsagaworkerstalled) pages after 5 when Temporal answers but no worker polls.

- `POST /orders` and both cancel routes answer `503` with `Retry-After` after their wait (`CHECKOUT_RESERVE_WAIT_MS`, `CHECKOUT_CANCEL_WAIT_MS`), logged as `checkout saga engine unavailable` or `cancel got no answer from the checkout saga`.
- A buyer who retries with a fresh `Idempotency-Key` each time leaves one hidden `RESERVING` order per attempt, and those count against the in-flight cap: the fourth such attempt answers `409 Too many pending orders` instead of `503`. Once Temporal is back the reaper rejects them, after `CHECKOUT_RESERVING_ORPHAN_SEC` and one `CHECKOUT_REAPER_INTERVAL_MS`. A retry under the same key adds no order.

The order-service's `/health/ready` answers `503` naming `temporal`. Railway reads it only at deploy, so the running order-service keeps serving, but a deploy of it fails its healthcheck: CD stops at "Deploy order-service", before the api, and production keeps the code it runs. Bring Temporal back, then **Re-run all jobs**. The api's and the gateway's readiness leave Temporal out, so a freeze, a rollback and an api deploy all still go through.

**What it stops.** Checkout and cancel: no new stock is held and no money is taken. Catalog, cart, `/pay` and the webhook keep serving, and a buyer who authorizes on an open session loses nothing: the webhook records the hold, and its `payment.authorized` job waits on the long ladder (about 33 minutes) before the dead-letter queue. Open runs wait where they are, since their state is in `temporal-postgres`. Once the server answers, the worker reconnects on its own (backoff up to 30s), and timers that fell due meanwhile fire at once.

**If checkout must not take orders meanwhile**, [freeze checkout](#freeze-checkout). It only redeploys the gateway, and turns the order-service's `503`s into the gateway's.

While the CLI cannot reach the server, read the in-flight sagas from the databases instead of `temporal workflow count`:

```sql
-- order-postgres
SELECT status, count(*) FROM orders WHERE status IN ('RESERVING', 'PENDING', 'CONFIRMING') GROUP BY status;
-- payment-postgres
SELECT status, count(*) FROM payment_orders WHERE status IN ('OPEN', 'AUTHORIZED') GROUP BY status;
-- inventory-postgres
SELECT status, count(*) FROM reservation_orders WHERE status = 'HELD' GROUP BY status;
```

**Rollback** to the checkout before the saga is in [Roll back to the checkout before the saga](#roll-back-to-the-checkout-before-the-saga). Its deploy needs no Temporal, but closing the sagas still open does.

**Terminate only once Temporal answers again, and only a run that cannot finish on its own**, such as a compensation that keeps failing or a nondeterminism error after a bad deploy. Every other open run resumes and compensates or completes by itself. A terminated run stops where it is, with no compensation, so first read its order in `order-postgres`, its payment header in `payment-postgres` and its stock header in `inventory-postgres`:

```sql
-- order-postgres
SELECT id, status FROM orders WHERE id = <order id>;
-- payment-postgres
SELECT order_id, status AS payment, authorized_at FROM payment_orders WHERE order_id = <order id>;
-- inventory-postgres
SELECT order_id, status AS stock, hold_until FROM reservation_orders WHERE order_id = <order id>;
```

A `HELD` stock row is released by the inventory-service's lapsed-hold sweep once `hold_until` passes. An `AUTHORIZED` payment holds the buyer's funds until Stripe voids it, after 7 days. So once the run is terminated, void it as in [Settle a payment by hand](#settle-a-payment-by-hand); a void in the Stripe dashboard alone leaves the payment rows `AUTHORIZED`. Terminate with:

```sh
# container (temporal), one run
t workflow terminate --namespace jcool --workflow-id checkout-<order id> --reason "<why>"
# every running saga, only after each one is reconciled as above; it asks to confirm with the count first
t workflow terminate --namespace jcool --query 'WorkflowType="CheckoutSaga" AND ExecutionStatus="Running"' --reason "<why>"
```

---

## Cut over checkout to the saga

The one-time switch from the single-transaction checkout to the saga, kept as the record of how it was done and as the way back. Checkout is frozen, orders from the old path drain on their own (the old TTL and reconcile sweeps close them and their sessions; no SQL by hand), and the saga code merges behind the freeze. No step assumes Temporal is healthy: a freeze is a gateway redeploy, and the gateway's healthcheck goes through the api's `/health/ready`, which leaves Temporal out. If Temporal stops at any step, keep the freeze on (or turn it back on) and work through [Temporal down](#temporal-down).

1. **Back up** the api's `Postgres`: a Railway snapshot, and a `pg_dump` through `railway connect Postgres` ([Back up](#back-up)).
2. **Freeze** ([Freeze checkout](#freeze-checkout)), then probe both `POST /orders` and `POST /orders/1/pay` on the public domain: each must answer `503` with `Retry-After`. If not, unfreeze and stop.
3. **Drain**, about 32 minutes. In `psql`, all four must reach zero rows:

   ```sql
   SELECT count(*) FROM orders WHERE status = 'PENDING';
   SELECT count(*) FROM payments WHERE status = 'PENDING';
   SELECT count(*) FROM reservations r
   WHERE r.status = 'HELD' AND NOT EXISTS (SELECT 1 FROM reservation_orders h WHERE h.order_id = r.order_id);
   SELECT status, count(*) FROM orders WHERE status IN ('RESERVING', 'CONFIRMING') GROUP BY status;
   ```

   Run the candidate query of [A refund is owed](#a-refund-is-owed) and keep its output; it does not block. Rows left after 45 minutes: stop and investigate, do not merge.
4. **Check the plan and Temporal.** `railway config plan` from the rebased branch must be empty, since the cut-over adds no service. In `railway ssh --service temporal`, with `t()` from [Check it](#check-it), `t operator cluster health` answers `SERVING` and `t task-queue describe --task-queue checkout-saga --namespace jcool` lists the api's pollers. If either fails, do not merge: unfreeze (the old checkout needs no Temporal) and work through [Temporal down](#temporal-down).
5. **Merge**, after probing the freeze once more. CI and CD apply migration 0032 in `preDeployCommand`, deploy the id-service, the api and the gateway, smoke `/health/ready`, then the user-service.
6. **Check the deploy.** `/health/ready` answers 200, which says nothing about Temporal. `SELECT status, count(*) FROM orders WHERE status IN ('RESERVING', 'PENDING', 'CONFIRMING') GROUP BY status;` is empty. The task queue lists pollers and `t workflow count --namespace jcool --query 'WorkflowType="CheckoutSaga"'` is 0.
7. **Unfreeze**, then check out at once with a test account on the public domain: `POST /orders` answers `201`; the run is `Running` in `t workflow list --namespace jcool --query 'WorkflowId="checkout-<order id>"'` and `t workflow describe --namespace jcool --workflow-id checkout-<order id>` shows `CheckoutStep` `AWAITING_AUTH`; `POST /orders/<order id>/pay` answers `201`, and paying it with a Stripe test card takes the order to `PAID` within a minute and the run to `Completed` in the same list. A second order cancels with `200` and `quantity_reserved` returns to where it was. If any of this fails, freeze again and fix forward.

### Roll back to the checkout before the saga

**Closed by the [checkout cut-over](#cut-checkout-over-to-the-order-service)**: the old checkout takes payments in the api, and that cut-over deleted the api's Stripe variables and dropped its payment tables. Kept as the record of how it was done.

A forward commit that restores the old checkout's wiring. Keep `.railway/railway.ts`, every migration (0032 stays: the `(status, placed_at)` index from 0031 serves the old queries), `infra/temporal/` and the freeze matcher. Never run `--confirm-destructive` or approve a destroy. The rollback deploys without Temporal, but closing the open sagas needs it, because their state lives only there.

1. **Freeze** and probe as in step 2 above; this works with Temporal down.
2. **Close every saga.** Admin-cancel each `CheckoutSaga` running in `AWAITING_AUTH` (`POST /admin/orders/<id>/cancel`), then wait for `t workflow count --namespace jcool --query 'WorkflowType="CheckoutSaga" AND ExecutionStatus="Running"'` to reach 0. With Temporal down, admin cancel answers `503` and the CLI cannot connect:
   - **Temporal is paused** (server or worker gone, `temporal-postgres` intact): take no shortcut. Keep the freeze, bring Temporal back ([Temporal down](#temporal-down)), then run this step as written. A buyer who pays on an open session meanwhile keeps the authorization, since its `payment.authorized` job waits on the long ladder. Track progress with the three queries in [Temporal down](#temporal-down), and do not merge the rollback while any saga order is not terminal.
   - **Temporal lost its state** (`temporal-postgres` broken beyond restore): no run will ever continue, so cleaning up in SQL is safe. Void every `requires_capture` PaymentIntent of those orders in the Stripe dashboard; a `CONFIRMING` order whose charge was already captured is a refund owed ([A refund is owed](#a-refund-is-owed)). After a `pg_dump`, reset the `RESERVING`, `PENDING` and `CONFIRMING` orders the way demo data is reset. Their holds in `inventory-postgres` stay `HELD` until the inventory-service's sweep releases them past `hold_until`; nothing reads them once step 5 brings stock back to the api. The three queries must come back empty before the merge.
3. **Settle the leftover authorizations**: for each `SELECT order_id FROM payment_orders WHERE status = 'AUTHORIZED';` (on `payment-postgres`), capture if the order is `PAID`, otherwise void it in the Stripe dashboard, and note it down.
4. **Delete the `REJECTED` orders**, which the old code would show to their buyers: `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'REJECTED'); DELETE FROM orders WHERE status = 'REJECTED';`.
5. **Commit** the old routes, use cases, consumers and config back (everything this cut-over removed, migrations and the kept files aside). The old checkout reserves stock in the api, so the same commit also brings stock back from the inventory-service: steps 1–3 of "Roll back" under [Cut stock over to the inventory-service](#cut-stock-over-to-the-inventory-service), `CHECKOUT_INVARIANT_NOT_BEFORE` included, and brings payments back from the payment-service in the same way ("Roll back" under [Cut payments over to the payment-service](#cut-payments-over-to-the-payment-service)). Then pass typecheck, `test:cov` and the old checkout's e2e suites, merge, and let CD deploy. Its `/health/ready` smoke passes with Temporal down; the old saga worker only logs connection errors.
6. **Unfreeze**, and check out once through the old path, which needs no Temporal.

---

## Put the gateway in front of the api

The `gateway` service (Caddy, `apps/gateway`) hands every public route to its service unchanged (the api, or the order-service, inventory-service and payment-service for theirs), answers `/internal/*` with 404, and tells each upstream who the client is. CD creates and deploys it without a public domain. Moving `jcool-ecommerce.up.railway.app` onto it is this manual step. Do it off-peak, because between the two renames the name routes nowhere for a few seconds.

**How the client address travels.** Railway's edge reaches the gateway from `100.64.0.0/10` and names the client in `X-Real-IP`. That is the only header Railway documents: its `X-Forwarded-For` arrives with two entries, and the last one is not the client. The gateway believes `X-Real-IP` only from `TRUSTED_PROXY_CIDRS`, and sends the api `X-Forwarded-For` with one entry, the client. It dials the api over IPv6 (`API_UPSTREAM=tcp6/…`): the private DNS also answers IPv4, and Go would dial that first. The api believes the header only from the private network's IPv6 range (`TRUST_PROXY=fd12::/16`), and the edge is not in it. So the same api value is right before the flip, after it, and after a rollback.

### Before the gateway change reaches `main`

Production refuses to boot without `TRUST_PROXY`:

```bash
railway variable set 'TRUST_PROXY=fd12::/16' --service jcool-ecommerce-backend --skip-deploys
```

Until the flip, nothing on the private network sends the api requests, so clients see no change.

### Probe on a temporary domain

```bash
railway domain --service gateway --port 8080     # prints gateway-….up.railway.app
GW=https://gateway-….up.railway.app
API=https://jcool-ecommerce.up.railway.app
```

1. **Contract.**
   - `curl -fsS "$GW/health/ready"` answers.
   - `diff <(curl -fsS "$API/docs-json") <(curl -fsS "$GW/docs-json")` prints nothing.
   - `curl -s -o /dev/null -w '%{http_code}\n' "$GW/internal/x"` prints `404`.
2. **The edge's range.**
   - Send `curl -fsS "$GW/health/live?probe=1"`, then find that request's access-log line in `railway logs --service gateway --lines 100`.
   - With `TRUSTED_PROXY_CIDRS` unset, `remote_ip` and `client_ip` both hold the edge's address. Check that it falls inside `100.64.0.0/10`, then trust that range (a redeploy follows):

   ```bash
   railway variable set 'TRUSTED_PROXY_CIDRS=100.64.0.0/10' --service gateway
   ```

   Separate several ranges with spaces. Never use `0.0.0.0/0` or `private_ranges`: they would let any client pick its own throttle key.
3. **Forged headers.**
   - Send `curl -fsS -H 'X-Real-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' "$GW/health/live?probe=2"`.
   - The log line must show your own public IP (`curl -s https://api.ipify.org`) as `client_ip`, never `203.0.113.9`.
   - If it shows the forged address, the edge passes `X-Real-IP` through unchecked. Delete `TRUSTED_PROXY_CIDRS` and do not flip.
4. **Two clients stay two clients.**
   - From two networks (a laptop and a phone hotspot), take turns running `curl -si "$GW/products" | grep -i x-ratelimit-remaining`.
   - Each network must count down on its own.
   - If they count down together, the api is not believing the gateway. Either `API_UPSTREAM` lost its `tcp6/` prefix, or the gateway's private address is outside `TRUST_PROXY`. Fix that before going on.

### Flip

```bash
railway domain update jcool-ecommerce.up.railway.app --service jcool-ecommerce-backend --domain jcool-ecommerce-direct
railway domain update "${GW#https://}" --service gateway --domain jcool-ecommerce
```

Then check the result:

- `curl -fsS "$API/health/ready"` answers.
- Step 4 passes against `$API`.
- The 429 rate per route stays normal for the next hour.

`APP_PUBLIC_URL` and the CD smoke test need no change, because the name stayed the same. Once the flip has held for a day, delete the direct domain, so the api can only be reached through the gateway:

```bash
railway domain delete jcool-ecommerce-direct.up.railway.app --service jcool-ecommerce-backend --yes
```

### Roll back

Reverse the renames. `TRUST_PROXY` stays as it is.

```bash
railway domain update jcool-ecommerce.up.railway.app --service gateway --domain jcool-ecommerce-gateway
railway domain update jcool-ecommerce-direct.up.railway.app --service jcool-ecommerce-backend --domain jcool-ecommerce
```

If the direct domain is already gone, create one with `railway domain --service jcool-ecommerce-backend --port 8080` and rename it the same way.

### Route `/auth` to another service

- `AUTH_UPSTREAM` on the gateway sends `/auth`, `/auth/*` and `/.well-known/jwks.json` there. Give it as `tcp6/<private domain>:<port>`, for the same reason as `API_UPSTREAM`.
- `AUTH_UPSTREAM_REQUIRED=true` is on: the gateway refuses to start without `AUTH_UPSTREAM`, so losing the variable fails the deploy instead of routing auth to an api that answers 404.
- `AUTH_WRITE_FREEZE=true` answers every write under `/auth` with `503` and `Retry-After: 120`, reads untouched. Use it while a migration must not race a login or a password change, and unset it after. It is off unless set.
- All three are set by hand and kept across every apply.

---

## The user-service

`apps/user-service` owns `/auth`, the user tables and the ES256 signing keys, on its own Postgres
(`user-postgres`). The gateway routes `/auth`, `/auth/*` and `/.well-known/jwks.json` to it; it has
no public domain of its own. CD deploys it right after the id-service, so its caller allowlist is out before the inventory-service that it admits.

### Redis durability

The user-service writes `auth:epoch:{userId}` and `auth:denylist:{jti}` to the shared Redis, and the api reads them. Both refuse to boot unless that Redis cannot silently lose them:

```
Redis cannot hold auth state: maxmemory-policy is allkeys-lru, not noeviction; appendonly is off. See RUNBOOK.md, "Redis durability".
```

An evicted denylist entry revives a logged-out token, and an evicted epoch lets a revoked session back in. The boot reads both settings from `INFO`, since managed Redis often disables `CONFIG`. Check the instance the same way after any Redis plan or provider change:

```bash
railway connect <redis service>             # opens redis-cli on the production instance
INFO memory                                 # maxmemory_policy must be noeviction; note maxmemory and used_memory
INFO persistence                            # aof_enabled must be 1
```

To turn AOF on, do it live first, then make it permanent:

1. `CONFIG SET appendonly yes`. Redis writes the AOF from what it holds in memory. Wait until `INFO persistence` shows `aof_enabled:1` and `aof_rewrite_in_progress:0`.
2. `CONFIG SET maxmemory-policy noeviction` if it is not already.
3. Put both in the Redis service's start command (Settings → Custom Start Command), for example `redis-server --appendonly yes --maxmemory-policy noeviction` plus whatever the command already carried, so a restart keeps them.

Doing it in this order matters: a Redis that restarts with AOF newly enabled and no AOF file on disk can come up empty instead of loading its RDB snapshot.

`noeviction` means a full Redis refuses writes. The catalog cache already reads through to Postgres when a `SET` fails, but the throttler writes on every request and answers 500 when it cannot. Keep `used_memory` under 80% of `maxmemory` and alert on it.

Locally, `docker-compose.yml` starts Redis with `--appendonly yes`. If the `redisdata` volume holds something you want to keep, run `docker exec jcool-redis redis-cli CONFIG SET appendonly yes` before recreating the container.

### Rebuilding the service from scratch

`railway config plan && railway config apply --yes` creates `user-postgres` and `user-service`, but
the service will not boot until its variables have values. One of them is a one-way door:

- `CSRF_SECRET` — changing it invalidates every CSRF cookie in circulation.

Set `IDENTITY_PIN_BOOTSTRAP=true` only for the first boot against an empty database, and leave it unset against one that already holds the pin. See [The id layout is permanent](#the-id-layout-is-permanent).

`REDIS_URL` is a reference to the api's instance (`auth:*` lives there). `JWT_ISSUER` is the public
URL and `JWT_AUDIENCE` is `jcool-api`; the api references both, so pick them once.

Generate the new secrets locally, and paste them in the dashboard (user-service → Variables), never on a command line:

```bash
openssl rand -hex 32                                                   # INTERNAL_API_TOKEN
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out es256.pem
awk '{printf "%s\\n", $0}' es256.pem                                   # the PEM on one line
rm es256.pem
```

`JWT_ES256_PRIVATE_KEYS` is `<kid>:<pem>`, for example `2026-09:-----BEGIN PRIVATE KEY-----\n…`, and `JWT_ES256_ACTIVE_KID` is that kid.

Then set the gateway's `AUTH_UPSTREAM` to `tcp6/${{user-service.RAILWAY_PRIVATE_DOMAIN}}:3000` and
`AUTH_UPSTREAM_REQUIRED=true`, and redeploy it. Check the service from inside first, since it has no
domain of its own:

```bash
railway ssh --service user-service
node -e "fetch('http://127.0.0.1:3000/health/ready').then(r => r.text()).then(console.log)"
node -e "fetch('http://127.0.0.1:3000/.well-known/jwks.json').then(r => r.text()).then(console.log)"
```

Then from outside: `curl -s "$PUBLIC_URL/.well-known/jwks.json"` must answer the same key set, and a
login must succeed. The api refuses every token until it can read that document — it is down for
everyone if the user-service is down.

### Rotate the ES256 signing key

Verifiers fetch `/.well-known/jwks.json`: the api keeps it for up to 10 minutes and refetches for a kid it has not seen at most every 30 seconds. A new key must be published before anything is signed with it:

1. Append the new `kid:pem` to `JWT_ES256_PRIVATE_KEYS` (comma-separated) and deploy. Both keys are now published; tokens are still signed with the old one.
2. Wait at least 10 minutes, then set `JWT_ES256_ACTIVE_KID` to the new kid and deploy.
3. Once `JWT_ACCESS_TTL` has passed, remove the old entry and deploy.

A key that leaked is the exception: drop it at once. Every token it signed is then refused, and clients log in again.

### Rotate `INTERNAL_API_TOKEN`

Move the current value to `INTERNAL_API_TOKEN_PREVIOUS`, set a new `INTERNAL_API_TOKEN`, and deploy. Both are accepted. The api reads the token as a reference, so it sends the new value only once it is redeployed too. A token the user-service refuses shows up as 503s on epoch misses, with the breaker still closed. Once every caller sends the new value, delete `INTERNAL_API_TOKEN_PREVIOUS` (see [Change Railway service config](#change-railway-service-config) for removing a variable). `INTERNAL_API_TOKEN` is the api's caller token on the user-service; every other caller has a token of its own ([Per-caller internal tokens](#per-caller-internal-tokens)).

---

## The api depends on the user-service

The api holds no user rows, no signing key and no `/auth` route. Four variables wire it to the
user-service, all required — the api refuses to boot without them, and `.railway/railway.ts` sets
each as a reference so the two cannot drift.

| Variable | Value |
| -------- | ----- |
| `AUTH_JWKS_URL` | the user-service's JWKS. The only key source: without it every request is refused |
| `JWT_ISSUER`, `JWT_AUDIENCE` | what the user-service signs |
| `USER_SERVICE_INTERNAL_URL`, `INTERNAL_API_TOKEN` | its internal API: session epochs on a Redis miss |

It also depends on the id-service for every write: `ID_SERVICE_URL` is the gateway's internal
listener (port 4000), the same one the user-service calls. The api mints each row id there, with
`x-caller: api`, and answers 503 without writing anything when no id can be minted. Reads keep
working.

Session epochs come from the keys the user-service publishes to the shared Redis. A missing key
costs a call to the user-service on the request path; if that call fails the request answers 503 —
never an open door, never a logout. A sustained `session_epoch_lookups_total{result="miss"}` means
Redis lost keys it should have kept; refill them from the database rather than through the request
path, with `USER_DATABASE_URL=… REDIS_URL=… pnpm --filter @jcool/user-service epochs:prewarm`. It
writes each epoch as a max, so a login racing it is never lowered back.

If the JWKS becomes unreachable, the api keeps verifying with the last set it loaded and retries the
endpoint every 30 seconds. A key dropped from the set stops verifying at the first fetch that
succeeds, not before.

The order-service and the inventory-service verify tokens the same way, with variables of their own ([The order-service](#the-order-service)).

---

## The inventory-service

`apps/inventory-service` owns stock: `stock_levels`, the holds in `reservations` and their per-order headers in `reservation_orders`, on its own Postgres (`inventory-postgres`). The order-service's checkout saga calls `/internal/v1/reservations` with `INVENTORY_SERVICE_TOKEN`, and the gateway routes `/admin/inventory` and `/admin/inventory/*` to it; it has no public domain. CD deploys it after the user-service and before the payment-service. Its routes and variables are in its [README](./apps/inventory-service/README.md).

It depends on the id-service for every row it writes (`ID_SERVICE_URL`, `x-caller: inventory-service`), on the shared Redis for the admin routes' denylist and session epochs, and on the user-service for an epoch missing from Redis (`USER_SERVICE_TOKEN`). Its readiness covers its Postgres and Redis only.

The api's stock tables were retired at the cut-over and have since been dropped by a migration (`0033_drop_retired_stock_tables.sql`).

### Seed stock

The pre-deploy command, `node dist/database/pre-deploy-cli.js`, migrates and then runs the seed best effort, in one process: Railway runs it without a shell, so an `&&` chain would never reach the seed. The seed lists every variant of the public catalog through the gateway (`CATALOG_PUBLIC_URL`, 100 per page), and gives each one with no level 1,000,000,000 on hand. A level that exists is never touched, so an operator's count wins. The deploy log has one line either way:

- `stock seed listed=<n> inserted=<n> present=<n>`: done. `listed=0` on a catalog that has products is the list cache answering an empty page; run it again after `CATALOG_CACHE_TTL_SEC` + `CACHE_STALE_WINDOW_SEC`.
- `stock seed skipped, nothing written: <why>`: a page did not answer or did not parse, so nothing was written at all. A large catalog can hit the gateway's throttle midway; the demo catalog is far below that.

By hand, from inside the service (it has the variables):

```sh
# container (inventory-service)
node dist/database/seed-stock.js        # without --best-effort: exit 1 on a catalog it cannot list, or one that lists nothing
```

A new variant gets no stock until the next seed: run it after adding products, or set the level through `PUT /admin/inventory/:variantId`.

---

## The payment-service

`apps/payment-service` owns payments: `payment_orders` (the per-order fence), `payments`, `webhook_events` and an `outbox`, on its own Postgres (`payment-postgres`). The order-service's `/pay` and checkout saga call `/internal/v1/payments` with `PAYMENT_SERVICE_TOKEN`, Stripe's webhook reaches `POST /webhooks/payment` through the gateway (`PAYMENT_UPSTREAM`, which the gateway refuses to start without), and it has no public domain. CD deploys it after the inventory-service and before the order-service. Its routes and variables are in its [README](./apps/payment-service/README.md).

It depends on the id-service for every row it writes (`ID_SERVICE_URL`, `x-caller: payment-service`), on Stripe, and on the shared Redis only to publish: its relay puts `payment.authorized` on the order-service's `order-events` queue under the same `QUEUE_PREFIX`. It consumes no queue, so it has no inbox and no worker. Its readiness covers Postgres and Redis only, so a Temporal outage never takes it out of rotation. Its reconcile sweep (`RECONCILE_*`) runs here, not in the order-service: it asks Stripe about sessions whose webhook never came, records a hold the webhook missed, retires a session Stripe expired and voids a hold left under a cancelled order. It never moves an order; the saga does that.

While it is down, `/pay` answers `502`, sagas wait in `CAPTURING` or `COMPENSATING` and move by themselves once it answers, and Stripe redelivers the webhooks it could not deliver ([PaymentScrapeDown](#paymentscrapedown)). A saga verifying an authorization waits too, but only until its payment deadline plus `SAGA_AUTH_GRACE_SEC` (180s): past that it expires the order and voids the hold once the service answers, so an outage that long costs a paying buyer the order, never the money.

While only Stripe is away, the service still answers: session, capture and cancel return a `503` coded `PROVIDER_UNAVAILABLE`, which the order-service's `payment-service` breaker does not count, so `/pay` answers `502` per attempt, captures and cancels retry, and status reads, which need no Stripe, keep verifying authorizations.

The api's payment tables were dropped by `0034_drop_retired_payment_tables.sql` at the [checkout cut-over](#cut-checkout-over-to-the-order-service), which also deleted the api's four Stripe and webhook variables.

---

## The order-service

`apps/order-service` owns checkout and orders: `orders`, `order_items`, `idempotency_keys`, an `outbox` and an `inbox`, on its own Postgres (`order-postgres`). It runs the checkout saga's Temporal worker and client, the reaper, the saga collector and the invariant checker, and is the only consumer of `order-events`: `payment.authorized` signals a saga, `order.paid` sends the confirmation mail through `SMTP_URL`. The gateway routes `/orders`, `/orders/*`, `/admin/orders` and `/admin/orders/*` to it (`ORDER_UPSTREAM`, which the gateway refuses to start without), and it has no public domain. CD deploys it after the payment-service and before the api. Its routes and variables are in its [README](./apps/order-service/README.md).

It calls four services, each with a token of its own ([Per-caller internal tokens](#per-caller-internal-tokens)), and the id-service for every row it writes (`x-caller: order-service`):

| Callee | Variables | For |
| --- | --- | --- |
| api | `API_SERVICE_URL`, `API_SERVICE_TOKEN` | the cart's lines and the SKU views, read before an order is written |
| inventory-service | `INVENTORY_SERVICE_URL`, `INVENTORY_SERVICE_TOKEN` | the stock branch of the saga, and the checker's status reads |
| payment-service | `PAYMENT_SERVICE_URL`, `PAYMENT_SERVICE_TOKEN` | `/pay`, the payment branch, and the checker's status reads |
| user-service | `USER_SERVICE_URL`, `USER_SERVICE_TOKEN` | session epochs on a Redis miss, and the buyer's address for `order.paid` |

It verifies access tokens like the api (`AUTH_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, the shared Redis's denylist and epochs). Its readiness covers Postgres, Redis and Temporal, and the worker's `RUNNING` state when `TEMPORAL_WORKER_ENABLED` is on ([Temporal down](#temporal-down)); its shutdown is in [The shutdown budget](#the-shutdown-budget).

The api's database keeps `orders`, `order_items` and `idempotency_keys` from before the cut-over, under `schema/retired/`, for a rollback. Nothing reads or writes them, and an order placed on the order-service is not in them.

### Checkout answers 503 with the api up

`POST /orders` reads the cart and the catalog from the api's internal routes before it writes anything. Anything but a `2xx` of the right shape (another status, a timeout, a network error, a body off its contract) is a `503` with `Retry-After`, and nothing has to be undone. A `4xx` or an off-contract body means configuration rather than load, so the order-service logs it at error as `api-internal answered off its contract`, with `path` and `status`:

- **`404`.** `API_SERVICE_URL` names the gateway, which answers `/internal/*` with 404, or a host without the route. It must be the api's private domain and port: a reference in `.railway/railway.ts`, `http://app:3000` in compose.
- **`401`.** `API_SERVICE_TOKEN` is not the api's `INTERNAL_CALLER_TOKEN_ORDER_SERVICE`; one of them has not redeployed since a rotation ([A caller answered `401` or `403`](#a-caller-answered-401-or-403)).
- **`403`.** The route's `@InternalCallers(...)` does not list `order-service`: a code change.

A `5xx`, a timeout or a network error counts against the `api-internal` breaker (`CircuitBreakerOpen{breaker="api-internal"}`); the `4xx`s, `429` and an off-contract body do not. To check the address and the token without touching data, ask for the SKU views of nothing, which the api refuses with `400` only once the guard has let the call through:

```sh
# container (order-service)
node -e "fetch(process.env.API_SERVICE_URL + '/internal/v1/catalog/sku-views', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.API_SERVICE_TOKEN, 'content-type': 'application/json' }, body: '{\"skuIds\":[]}' }).then(r => console.log(new URL(process.env.API_SERVICE_URL).host, r.status))"
```

`400` is right; `404`, `401` and `403` read as above.

### `order.paid` waits for the user-service

The order confirmation reads the buyer's address from the user-service before its transaction opens, with a 500 ms timeout (`USER_SERVICE_TIMEOUT_MS`) behind the `user-service` breaker. A failure goes back on a ladder of its own: `ORDER_PAID_CONSUMER_ATTEMPTS` (15) deliveries, doubling from `QUEUE_CONSUMER_BACKOFF_MS` up to `ORDER_PAID_CONSUMER_BACKOFF_CAP_MS` (5 minutes). That rides out about 33 minutes of outage. `payment.authorized` shares this ladder, so tuning the order-service's `ORDER_PAID_CONSUMER_*` moves both; the api's `catalog.*` events ride a ladder of the same name, set on the api.

A buyer the user-service does not know is retried until the event is `USER_DIRECTORY_NOT_FOUND_GRACE` (10m) old, since a freshly restored directory can miss the newest accounts. After that it is parked as permanent.

Either way `DeadLetterQueued` pages for `jcool-order`. Once the user-service answers again, [replay `order-events`](#dead-letter-queues).

---

## Cross-service settings

No process sees both values, so nothing checks these at boot. Keep them when changing either side:

| Rule | Why |
| --- | --- |
| inventory-service `INVENTORY_TRY_LOCK_TIMEOUT_MS` (2000) < order-service `CHECKOUT_TRY_TIMEOUT_MS` (3000) | The order-service gives a Try that long over HTTP, then aborts it and fences the hold with a release. A lock budget at or above it turns contended Tries into `503`s the service would have answered |
| order-service `SAGA_ACTIVITY_TIMEOUT_MS` > `INVENTORY_COMMAND_TIMEOUT_MS` + 5000 | Checked by the order-service itself: a commit, release or restock gets its full timeout inside the activity's |
| order-service `SAGA_ACTIVITY_TIMEOUT_MS` > `PAYMENT_COMMAND_TIMEOUT_MS` + 5000, and > each of its three breaker timeouts | Checked by the order-service itself: a payment command gets its full timeout inside the activity's. The breakers are built per callee, never from `BREAKER_TIMEOUT_MS`: `inventory-service` at `max(CHECKOUT_TRY_TIMEOUT_MS, INVENTORY_COMMAND_TIMEOUT_MS)` + 1000, `payment-service` at `PAYMENT_COMMAND_TIMEOUT_MS` + 1000, `api-internal` at `API_SERVICE_TIMEOUT_MS` + 1000 |
| 4 × payment-service `PAYMENT_CAPTURE_TIMEOUT_MS` (10000) + 1000 ≤ order-service `PAYMENT_COMMAND_TIMEOUT_MS` (45000) | A cancel there chains up to four Stripe calls, each bounded by `PAYMENT_CAPTURE_TIMEOUT_MS`. A command timeout under that sum aborts a cancel on the order-service's side while the payment-service is still carrying it out |
| order-service `CHECKOUT_PAY_CUTOFF_SEC` (1980) ≥ payment-service `PAYMENT_SESSION_MIN_TTL_SEC` (1800) + `PAYMENT_SESSION_EXPIRY_MARGIN_SEC` (120) + 60 | `/pay` opens a session only while the cutoff of the payment window remains. A smaller cutoff lets `/pay` ask for a session that expires sooner than Stripe allows, which the payment-service refuses as `CLOSED` |
| payment-service `ORDER_PAID_CONSUMER_ATTEMPTS` (15) = order-service `ORDER_PAID_CONSUMER_ATTEMPTS` (15) | BullMQ stamps the attempts on a job when it is added, so the payment-service's value is how many deliveries `payment.authorized` gets, while only the order-service's worker reads `ORDER_PAID_CONSUMER_BACKOFF_CAP_MS`. The order-service runs on its code default and `.railway/railway.ts` sets the payment-service's as a literal, so change one and you change the other |
| payment-service `QUEUE_PREFIX` = order-service `QUEUE_PREFIX` (`bull`) | A different prefix makes the relay write jobs under keys the order-service's worker never reads |
| order-service `SHUTDOWN_GRACE_PERIOD_MS` (5000) + `TEMPORAL_WORKER_SHUTDOWN_GRACE_MS` (4000) + `TEMPORAL_WORKER_SHUTDOWN_FORCE_MS` (4000) + 1000 + 2 × 5000 ≤ its `drainingSeconds` (30) × 1000 − 1000 | `drainingSeconds` lives in `.railway/railway.ts`, the rest in the environment, so nothing compares them. Past it, Railway kills the process mid-drain ([The shutdown budget](#the-shutdown-budget)) |
| `METRICS_TOKEN` equal on the api, the order-service, the inventory-service and the payment-service | Prometheus sends one token to every target; the three services reference the api's |

---

## Per-caller internal tokens

Every internal API admits each caller by a token of its own, and each route lists the callers it admits ([decision record](./docs/system-architecture.md#internal-apis-admit-callers-by-a-token-each)):

| Callee | Caller | Callee's variable | Caller's variable | Routes |
| --- | --- | --- | --- | --- |
| user-service | api | `INTERNAL_API_TOKEN` (+ `_PREVIOUS`) | `INTERNAL_API_TOKEN` (reference) | `sessions/:userId/epoch`, `users/:id/summary`, `cutover/digest` |
| user-service | inventory-service | `INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE` (+ `_PREVIOUS`) | `USER_SERVICE_TOKEN` (reference) | `sessions/:userId/epoch` |
| user-service | order-service | `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` (+ `_PREVIOUS`) | `USER_SERVICE_TOKEN` (reference) | `sessions/:userId/epoch`, `users/:id/summary` |
| api | order-service | `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` (+ `_PREVIOUS`) | `API_SERVICE_TOKEN` (reference) | `/internal/v1/carts/:userId/lines`, `/internal/v1/catalog/sku-views` |
| inventory-service | api | `INTERNAL_CALLER_TOKEN_API` (+ `_PREVIOUS`) | `INVENTORY_SERVICE_TOKEN` (reference) | `/internal/v1/reservations/*` |
| inventory-service | order-service | `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` (+ `_PREVIOUS`) | `INVENTORY_SERVICE_TOKEN` (reference) | `/internal/v1/reservations/*` |
| payment-service | api | `INTERNAL_CALLER_TOKEN_API` (+ `_PREVIOUS`) | `PAYMENT_SERVICE_TOKEN` (reference) | `/internal/v1/payments/*` |
| payment-service | order-service | `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` (+ `_PREVIOUS`) | `PAYMENT_SERVICE_TOKEN` (reference) | `/internal/v1/payments/*` |

The caller's variable is a reference to the callee's in `.railway/railway.ts`, so only the callee's is ever set by hand. A callee refuses to boot with no caller token at all, or with two callers sharing one. Since the checkout cut-over the api calls neither participant; its rows stay, and its tokens set, for a rollback until the next contract step removes them.

### Set one

Each value is generated on its own and goes in through stdin, so it is never on a command line or in history:

```bash
# local, after `railway link`
openssl rand -hex 32 | tr -d '\n' | railway variable set INTERNAL_CALLER_TOKEN_API --stdin --service inventory-service --skip-deploys
openssl rand -hex 32 | tr -d '\n' | railway variable set INTERNAL_CALLER_TOKEN_API --stdin --service payment-service --skip-deploys
openssl rand -hex 32 | tr -d '\n' | railway variable set INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE --stdin --service user-service --skip-deploys
for s in jcool-ecommerce-backend inventory-service payment-service user-service; do
  openssl rand -hex 32 | tr -d '\n' | railway variable set INTERNAL_CALLER_TOKEN_ORDER_SERVICE --stdin --service "$s" --skip-deploys
done
```

Then deploy the callee, then the caller, which reads the new value through its reference only once it redeploys.

### Rotate one

1. Copy the current value into `_PREVIOUS`, then set a new current one, both on the callee, and redeploy it. Both values are accepted.
2. Redeploy the caller: it now sends the new value.
3. Once no request carries the old one (the callee logs `internal caller token not recognized` for a value it does not know), unset `_PREVIOUS` as [Change Railway service config](#change-railway-service-config) removes a variable, and redeploy the callee. Never set it to an empty string: a `_PREVIOUS` under 32 characters stops the callee from booting.

### A caller answered `401` or `403`

The callee logs each refusal at warn as `request rejected`, with the reason in `cause` and never the token:

- **`401`, `internal caller token not recognized`.** The caller sends a value the callee does not hold: the caller has not redeployed since a rotation, or the callee's variable was set without a redeploy. Redeploy the one that is behind.
- **`401`, `missing internal caller bearer token`.** The caller sends none; its `*_SERVICE_TOKEN` is empty.
- **`403`, `internal caller <name> is not allowed on this route`.** The token is valid, but that caller is not on the route's list. That is a code change, not a variable: the route's `@InternalCallers(...)` decides.

On the order-service's side a refused Try or cart read is a checkout `503`, a refused `/pay` is a `502`, a refused user-service read leaves `order.paid` on its ladder, and refused commands keep retrying in their saga until the token is put right.

### Check that no two tokens match

Run on a local machine, never in CI: `--kv` prints raw values. Each line prints a 12-character fingerprint and nothing else; every fingerprint must differ.

```bash
# local, after `railway link`
fp() { railway variable list --service "$1" --kv | grep "^$2=" | cut -d= -f2- | tr -d '\n' | shasum -a 256 | cut -c1-12; }
for v in INTERNAL_CALLER_TOKEN_ORDER_SERVICE INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS; do echo "api $v $(fp jcool-ecommerce-backend $v)"; done
for s in inventory-service payment-service; do
  for v in INTERNAL_CALLER_TOKEN_API INTERNAL_CALLER_TOKEN_API_PREVIOUS INTERNAL_CALLER_TOKEN_ORDER_SERVICE INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS; do echo "$s $v $(fp $s $v)"; done
done
for v in INTERNAL_API_TOKEN INTERNAL_API_TOKEN_PREVIOUS INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE_PREVIOUS INTERNAL_CALLER_TOKEN_ORDER_SERVICE INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS; do echo "user-service $v $(fp user-service $v)"; done
```

An unset variable prints `e3b0c44298fc`, the fingerprint of nothing; that one may repeat. The caller-side variables are references to these, so they are not compared.

---

## Cut stock over to the inventory-service

The one-time move of stock from the api's tables to the inventory-service. It needs the public domain on the gateway first ([Put the gateway in front of the api](#put-the-gateway-in-front-of-the-api)): after the merge only the gateway routes `/admin/inventory*` to the inventory-service. Railway's data is demo data and may be reset, but take the backup anyway. The merge deletes no Railway variable, so its additions are applied before it, from the head of the branch rebased onto `main`.

1. **Back up** the api's `Postgres`: a snapshot, or a quick `pg_dump` ([Back up](#back-up)).
2. **Freeze** ([Freeze checkout](#freeze-checkout)), then probe `POST /orders` and `POST /orders/1/pay` on the public domain: both must answer `503` with `Retry-After`. If not, unfreeze and stop.
3. **Drain**: wait for `sum(checkout_sagas_open) == 0` in Prometheus. With the gauge absent, count with `t workflow count --namespace jcool --query 'WorkflowType="CheckoutSaga" AND ExecutionStatus="Running"'` ([Read a saga](#read-a-saga)).
4. **Apply the additions**, from the rebased branch:
   - `railway config plan` must only create `inventory-postgres` and `inventory-service`, and add `INVENTORY_SERVICE_URL` and `INVENTORY_SERVICE_TOKEN` (api), `INVENTORY_UPSTREAM` (gateway), `INVENTORY_TARGET` (prometheus), with no destroy. The `preserve()`d names nobody has set yet (`INTERNAL_CALLER_TOKEN_API*` on the inventory-service, `INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE*` on the user-service) may be listed as additions or not at all; either is fine. Then `railway config apply --yes`: the new service is created without a source, so it does not boot yet, and every service whose config changed redeploys on the code it runs, which ignores the new names. If the plan shows a destroy, do not apply from the branch; merge, and follow [Review a destructive change](#review-a-destructive-change) from a checkout of `main`, keeping the freeze on and merging nothing else while the run waits.
   - Set `INTERNAL_CALLER_TOKEN_API` on the inventory-service and `INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE` on the user-service, as in [Set one](#set-one). Leave both `_PREVIOUS` unset, not empty, until the first rotation.
   - `railway variable set "CHECKOUT_INVARIANT_NOT_BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" --service jcool-ecommerce-backend --skip-deploys`: every order settled before it has its header in the api's retired table, where the checker no longer looks ([`CHECKOUT_INVARIANT_NOT_BEFORE`](#checkout_invariant_not_before)).
   - [Check that no two tokens match](#check-that-no-two-tokens-match).
   - `railway config plan --detailed-exit-code` exits 0.
5. **Merge**, after probing the freeze once more (the apply redeployed the gateway). CD's plan is empty, so it only deploys: id-service → user-service → inventory-service (migrate, then the seed) → api → gateway → smoke.
6. **Check the deploy.**
   - The inventory-service's readiness from inside it: `railway ssh --service inventory-service`, then `node -e "fetch('http://127.0.0.1:3000/health/ready').then(r => r.text()).then(console.log)"`.
   - Its deploy log has `stock seed listed=<n>` with `n` above 0 and no `skipped`; otherwise run the seed by hand from `railway ssh --service inventory-service` and check its line ([Seed stock](#seed-stock)).
   - `GET /admin/inventory/<variant id>` through the public domain, with an admin token, answers `quantityOnHand` 1000000000.
   - From the latest `main`, `railway up --ci --service prometheus` and `scripts/railway-wait-for-rollout.sh prometheus`; then in its container `up{job="jcool-inventory"}` is 1, and `/api/v1/rules` lists the SLO group with its `job="jcool-api"` selectors and `InventoryScrapeDown` ([Deploy the monitoring stack](#deploy-the-monitoring-stack)).
7. **Unfreeze**, then check out at once through the public domain with a test account: `POST /orders`, `POST /orders/<id>/pay`, a Stripe test card, and the order reaches `PAID`; that variant's on-hand is one lower. If anything fails, freeze again, wait for `sum(checkout_sagas_open) == 0`, and fix forward or roll back (below).
8. After `CHECKOUT_INVARIANT_INTERVAL_MS` plus `CHECKOUT_INVARIANT_SETTLE_SEC`, `checkout_invariant_violations` reads 0 for every `kind`.

A merge postponed after step 4 breaks nothing: the applied config only adds names the running code ignores. To run the cut-over again, set `CHECKOUT_INVARIANT_NOT_BEFORE` again once the drain is done.

**If Temporal stops during the window** (`CheckoutSagaEngineDown`, [Temporal down](#temporal-down)): the freeze still deploys, because the gateway's healthcheck goes through the api's readiness and that leaves Temporal out. The drain can no longer be measured, though (`checkout_sagas_open` is withdrawn and the CLI cannot connect), so do not merge and do not unfreeze. Bring Temporal back, wait for `sum(checkout_sagas_open) == 0`, and continue from step 3.

### Roll back

Frozen, and only once `sum(checkout_sagas_open) == 0`: a hold in `inventory-postgres` does not exist in the api's tables. Order's inventory port has since moved to the order-service, so [roll back the checkout cut-over](#roll-back-the-checkout-cut-over) first. The rollback is a forward commit, never a `git revert` of the squash:

1. **Restore the api's old wiring**: its in-process stock code and tests, the in-process binding of Order's inventory port, the stock schema back in its module with `schema/index.ts` pointing at it, and the api's stock config. Remove the `@inventory` route from `apps/gateway/Caddyfile` (the entrypoint still requires `INVENTORY_UPSTREAM`, which stays in the IaC) and the "Deploy inventory-service" step from `cd.yml`.
2. **Keep as merged**: `.railway/railway.ts`, `scripts/check-railway-flip-vars.mjs`, every migration and `_journal.json`, `infra/prometheus`, the freeze matcher, `packages/internal-contracts`, `@jcool/auth-verifier/session-state`, `@jcool/platform/internal-api` and the user-service's guard. CD's plan is then empty, and the api ignores the variables it no longer reads. A plan with a destroy means the rollback commit is wrong; never approve a destroy for a rollback.
3. **Before merging it**, set `CHECKOUT_INVARIANT_NOT_BEFORE` to the current UTC time, as in step 4: orders settled since the cut-over have their headers in `inventory-postgres`, and the restored checker would report each one.
4. **Merge**, then unfreeze as in step 7. The inventory-service and `inventory-postgres` keep running their last deploy with no caller, and `jcool-inventory` stays up. Once the migration that drops the api's stock tables has run, the restored schema needs a migration that recreates them (`pnpm db:generate`); their old numbers are gone, which is enough for demo data.

The rollback deploys without Temporal (the api's and the gateway's healthchecks leave it out), but its drain needs it: with Temporal down, keep the freeze, bring it back as in [Temporal down](#temporal-down), wait for `sum(checkout_sagas_open) == 0`, and only then merge. A saga still open would carry on in the in-process wiring and commit or release in the api's tables, where it has no hold.

---

## Cut payments over to the payment-service

The one-time move of payments from the api to the payment-service, together with the split of the api's one shared queue into `order-events` and `api-events`. It needs the public domain on the gateway first ([Put the gateway in front of the api](#put-the-gateway-in-front-of-the-api)): after the merge only the gateway routes `/webhooks/payment` to the payment-service. Railway's data is demo data and may be reset, but take the backup anyway. Tell the shop's admins not to edit the catalog during the window: a catalog event written to the old queue after its drain would have no consumer. If one slips through, [rebuild the search index](#rebuild-the-search-index) afterwards. The merge deletes no Railway variable (the api keeps its four Stripe and webhook variables), so its additions are applied before it, from the head of the branch rebased onto `main`.

1. **Back up** the api's `Postgres`: a snapshot, or a quick `pg_dump` ([Back up](#back-up)).
2. **Freeze** ([Freeze checkout](#freeze-checkout)), then probe `POST /orders` and `POST /orders/1/pay` on the public domain: both must answer `503` with `Retry-After`. If not, unfreeze and stop.
3. **Drain**, and wait for all of these:
   - `sum(checkout_sagas_open) == 0` in Prometheus. With the gauge absent, count with `t workflow count --namespace jcool --query 'WorkflowType="CheckoutSaga" AND ExecutionStatus="Running"'` ([Read a saga](#read-a-saga)).
   - `max(payment_authorized_uncaptured_oldest_seconds) == 0`, and in the api's database (`railway connect Postgres`) `SELECT count(*) FROM payments WHERE status = 'AUTHORIZED'` returns 0. One that remains is settled by the next reconcile tick (`RECONCILE_INTERVAL_MS`), or by a void in the Stripe dashboard as in [PaymentAuthorizationUncaptured](#paymentauthorizationuncaptured).
   - The queue the running api still uses is empty: `sum(messaging_queue_jobs{queue="domain-events",state=~"wait|prioritized|active|delayed"}) == 0`. Then, in the api's container (`railway ssh --service jcool-ecommerce-backend`), `npm run queue:replay-dlq:prod` without `--apply` lists its dead-letter queue, `domain-events-dlq`. Replay what is there with this CLI before the merge, or note it and drop it (demo data): after the merge nothing reads either old queue, and the new CLI does not know them.
4. **Apply the additions**, from the rebased branch:
   - `railway config plan` must only create `payment-postgres` and `payment-service`, and add `PAYMENT_SERVICE_URL` and `PAYMENT_SERVICE_TOKEN` (api), `PAYMENT_UPSTREAM` (gateway) and `PAYMENT_TARGET` (prometheus), with no destroy. Then `railway config apply --yes`: the new service is created without a source, so it does not boot yet, and every service whose config changed redeploys on the code it runs, which ignores the new names. If the plan shows a destroy, do not apply from the branch; merge, and follow [Review a destructive change](#review-a-destructive-change) from a checkout of `main`, keeping the freeze on and merging nothing else while the run waits.
   - Copy the four Stripe and webhook variables from the api to the payment-service. The values are never printed:

     ```bash
     # local, after `railway link`
     for n in STRIPE_SECRET_KEY STRIPE_SUCCESS_URL STRIPE_CANCEL_URL PAYMENT_WEBHOOK_SECRET; do
       v=$(railway variable list --service jcool-ecommerce-backend --kv | sed -n "s/^$n=//p")
       [ -n "$v" ] && printf %s "$v" | railway variable set "$n" --stdin --service payment-service --skip-deploys
     done
     ```

     A variable the api never set (usually `STRIPE_CANCEL_URL`) is skipped, and the payment-service uses its default.
   - Set `INTERNAL_CALLER_TOKEN_API` on the payment-service, as in [Set one](#set-one), with a value of its own. Leave `_PREVIOUS` unset, not empty, until the first rotation.
   - `railway variable set "CHECKOUT_INVARIANT_NOT_BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" --service jcool-ecommerce-backend --skip-deploys`: every order settled before it has its header in the api's retired payment tables, where the checker no longer looks ([`CHECKOUT_INVARIANT_NOT_BEFORE`](#checkout_invariant_not_before)).
   - [Check that no two tokens match](#check-that-no-two-tokens-match).
   - `railway config plan --detailed-exit-code` exits 0.
5. **Merge**, after probing the freeze once more. CD's plan is empty, so it only deploys: id-service → user-service → inventory-service → payment-service (migrate) → api → gateway → smoke. Between the new api going live and the new gateway going live, a webhook that still reaches the api answers `404`; Stripe redelivers on its schedule and the next attempt reaches the payment-service. After the drain no session is open, so those webhooks carry no new authorization.
6. **Check the deploy.**
   - The payment-service's readiness from inside it: `railway ssh --service payment-service`, then `node -e "fetch('http://127.0.0.1:3000/health/ready').then(r => r.text()).then(console.log)"`. Its boot log has no Stripe guard error.
   - From the latest `main`, `railway up --ci --service prometheus` and `scripts/railway-wait-for-rollout.sh prometheus`; then in its container `up{job="jcool-payment"}` is 1, `payment_authorized_uncaptured_oldest_seconds{job="jcool-payment"}` is present, and `/api/v1/rules` lists `PaymentScrapeDown` and the `MessagingQueueMetricsAbsent` branch of each queue ([Deploy the monitoring stack](#deploy-the-monitoring-stack)).
7. **Unfreeze**, then check out at once through the public domain with a test account: `POST /orders`, `POST /orders/<id>/pay`, a Stripe test card, and the order reaches `PAID`. In the Stripe dashboard the PaymentIntent reads `succeeded` (captured) and the webhook endpoint's latest delivery is `2xx`, which proves the gateway route and the copied secret. If anything fails, freeze again, wait for `sum(checkout_sagas_open) == 0`, and fix forward or roll back (below).
8. After `CHECKOUT_INVARIANT_INTERVAL_MS` plus `CHECKOUT_INVARIANT_SETTLE_SEC`, `checkout_invariant_violations` reads 0 for every `kind`.

A merge postponed after step 4 breaks nothing: the applied config only adds names the running code ignores, and the payment-service has no source yet. To run the cut-over again, set `CHECKOUT_INVARIANT_NOT_BEFORE` again once the drain is done.

**If Temporal stops during the window** (`CheckoutSagaEngineDown`, [Temporal down](#temporal-down)): the freeze still deploys, because the gateway's healthcheck goes through the api's readiness and that leaves Temporal out; the payment-service's readiness leaves it out too. The drain can no longer be measured, though (`checkout_sagas_open` is withdrawn and the CLI cannot connect), so do not merge and do not unfreeze. Bring Temporal back, wait for the conditions of step 3, and continue from there. A `payment.authorized` job produced meanwhile retries on the long ladder and reaches its saga if Temporal is back within about 33 minutes; past that it lands in `order-events-dlq`, and is replayed with `--queue order-events` once Temporal answers ([A `payment.authorized` in the dead-letter queue](#a-paymentauthorized-in-the-dead-letter-queue)).

### Roll back

**Closed by the [checkout cut-over](#cut-checkout-over-to-the-order-service)**, which deleted the api's four Stripe and webhook variables and dropped its payment tables (`0034_drop_retired_payment_tables.sql`); kept as the record of how it was done.

Frozen, and only once `sum(checkout_sagas_open) == 0` and `payment-postgres` (`railway connect payment-postgres`) holds no `AUTHORIZED` header or attempt (`SELECT count(*) FROM payment_orders WHERE status = 'AUTHORIZED'`, and the same on `payments`). Wait for the payment-service's reconcile, or void it in the Stripe dashboard ([Settle a payment by hand](#settle-a-payment-by-hand)). The rollback is a forward commit, never a `git revert` of the squash:

1. **Restore the api's payment wiring**: its payment module and tests, the in-process binding of Order's payment port, the line in the schema barrel that points back at the module, the Stripe config and boot guard, `rawBody: true` in `apps/api/src/main.ts` and `apps/api/test/setup/test-app.factory.ts` (the webhook signature is checked over the raw body), and the `stripe` and `uuid` dependencies in `apps/api/package.json`. Remove the `@payment` route from `apps/gateway/Caddyfile` (the entrypoint still requires `PAYMENT_UPSTREAM`, which stays in the IaC) and the "Deploy payment-service" step from `cd.yml`. The api's four Stripe and webhook variables are still set, so it boots at once.
2. **Keep as merged**: `.railway/railway.ts`, every migration and `_journal.json`, `infra/prometheus`, `packages/messaging` and the queue split (the api's route table still sends `payment.authorized` to `order-events`), `packages/internal-contracts`. CD's plan is then empty, and the api ignores the variables it no longer reads. A plan with a destroy means the rollback commit is wrong; never approve a destroy for a rollback.
3. **Before merging it**, set `CHECKOUT_INVARIANT_NOT_BEFORE` to the current UTC time, as in step 4: orders settled since the cut-over have their headers in `payment-postgres`, and the restored checker would report each one.
4. **Merge**, then unfreeze as in step 7. The payment-service and `payment-postgres` keep running their last deploy, though no webhook reaches them any more, and `jcool-payment` stays up. Its reconcile sweep goes on voiding late authorizations of the orders it holds a header for.

The rollback deploys without Temporal (the readiness of the api, the payment-service and the gateway leaves it out), but its drain needs it: with Temporal down, keep the freeze, bring it back as in [Temporal down](#temporal-down), wait for `sum(checkout_sagas_open) == 0` and for no `AUTHORIZED` on `payment-postgres`, and only then merge. A saga still open would carry on in the in-process wiring and capture or void in the api's payment tables, where it has no header.

---

## Cut checkout over to the order-service

The one-time move of checkout and orders from the api to the order-service. It needs the public domain on the gateway first ([Put the gateway in front of the api](#put-the-gateway-in-front-of-the-api)): after the merge only the gateway routes `/orders*` and `/admin/orders*` to the order-service. Orders already in the api's database do not move; Railway's data is demo data, so the order-service starts empty, but take the backup anyway. The Temporal worker changes process, not namespace or task queue: the workflow code moved unchanged, so a history recorded by the api's worker replays on the order-service's. Each side's activities see only their own database, though, so the two workers must never poll the queue with a saga open: the drain below, under the freeze, ensures that.

Unlike the earlier cut-overs, this merge both adds and deletes Railway config: it adds the order-service and its tokens, and deletes the api's four Stripe and webhook variables, which the payment-service has carried since the [payment cut-over](#cut-payments-over-to-the-payment-service) and the running api no longer reads. So nothing is applied from the branch: merge, let CD stop for review, apply from `main` while it waits ([Review a destructive change](#review-a-destructive-change)), then approve.

1. **Back up** the api's `Postgres`: a quick `pg_dump` ([Back up](#back-up)).
2. **Freeze** ([Freeze checkout](#freeze-checkout)), then probe `POST /orders` and `POST /orders/1/pay` on the public domain: both must answer `503` with `Retry-After: 120`. If not, unfreeze and stop. A gateway redeploy needs only the api healthy, so this step and step 8 work while Temporal is down.
3. **Drain**, and wait for all of these:
   - To shorten it, list the `PENDING` orders with `GET /admin/orders?status=PENDING` and cancel each with `POST /admin/orders/<id>/cancel`; the admin routes are not frozen, and the saga compensates as for any cancel.
   - `sum(checkout_sagas_open) == 0` in Prometheus, and `t workflow count --namespace jcool --query 'WorkflowType="CheckoutSaga" AND ExecutionStatus="Running"'` is 0 ([Read a saga](#read-a-saga)).
   - `order-events` is empty: `sum(messaging_queue_jobs{queue="order-events",state=~"wait|prioritized|active|delayed"}) == 0`.
   - In the api's database (`railway connect Postgres`), `SELECT count(*) FROM orders WHERE status = 'RESERVING'` returns 0.
   - In the same database, `SELECT event_type, count(*) FROM outbox WHERE published_at IS NULL GROUP BY 1` lists no `order.*` row. After the merge the api's relay has no route for them: they are never delivered, `OutboxMessageStale` pages for good, and 100 of them fill every batch ahead of the catalog's events. The relay sends a row within a tick while Redis is up, so a row that stays is a stuck relay ([Outbox relay is not draining](#outbox-relay-is-not-draining)).
   - In the api's container (`railway ssh --service jcool-ecommerce-backend`), `npm run queue:replay-dlq:prod -- --queue order-events` without `--apply` lists `order-events-dlq`. Replay what is there with this CLI before the merge, or note it and drop it (demo data): after the merge the api's CLI refuses that queue, and the order-service's inbox holds none of the api's claims.
4. **Merge**, after probing the freeze once more. CD's plan job reports a destructive change and the run waits at `production-destructive`. **Do not approve yet.**
5. **Apply by hand from a checkout of `main`** while the run waits:
   - `railway config plan` must show exactly this phase's additions (`order-postgres` and `order-service`; `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` and its `_PREVIOUS` on the api, the inventory-service, the payment-service and the user-service; `ORDER_UPSTREAM` on the gateway; `ORDER_TARGET` on prometheus) and exactly four destroys on the api: `PAYMENT_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`. Anything else: reject the run and stop.
   - `railway config apply --confirm-destructive`. The order-service is created without a source, so it does not boot yet; every service whose config changed redeploys on the code it runs, which ignores the new names and never reads the four deleted ones. The freeze stays on, since `CHECKOUT_WRITE_FREEZE` is preserved.
   - Set `INTERNAL_CALLER_TOKEN_ORDER_SERVICE` on the api, the inventory-service, the payment-service and the user-service, four different values ([Set one](#set-one)). Leave each `_PREVIOUS` unset, not empty, until the first rotation.
   - Copy the mail settings from the api to the order-service, never printing them:

     ```bash
     # local, after `railway link`
     for n in SMTP_URL MAIL_FROM; do
       v=$(railway variable list --service jcool-ecommerce-backend --kv | sed -n "s/^$n=//p")
       [ -n "$v" ] && printf %s "$v" | railway variable set "$n" --stdin --service order-service --skip-deploys
     done
     ```

   - [Check that no two tokens match](#check-that-no-two-tokens-match). The order-service's `*_SERVICE_TOKEN`s are references to these, so they are not compared.
   - `railway config plan --detailed-exit-code` exits 0, then probe the freeze again (the apply redeployed the gateway).
6. **Approve** the run. The deploy job plans again, finds nothing to change, skips the apply and deploys id-service → user-service → inventory-service → payment-service → order-service (migrate) → api (migrate, which drops its payment tables) → gateway → smoke. The user-service, whose allowlist now has `order-service`, is live before the order-service, so no session-epoch miss answers `503`. Between the new api going live and the new gateway going live, order reads answer `404` and writes stay frozen. Do not use `POST /admin/orders/<id>/cancel` until CD has finished.
7. **Check the deploy.**
   - The order-service and the api passed `/health/ready` in CD; the order-service's includes Temporal. `GET /orders` on the public domain with a buyer's token answers `200`.
   - `t task-queue describe --task-queue checkout-saga --namespace jcool` lists pollers whose identity starts with `order-service@`; a poller of the api, if still listed, has a last access time that stopped when the old api shut down.
   - From the latest `main`, `railway up --ci --service prometheus` and `scripts/railway-wait-for-rollout.sh prometheus`; then in its container `up{job="jcool-order"}` is 1, `checkout_saga_engine_up` carries `job="jcool-order"`, `/api/v1/rules` lists `OrderScrapeDown`, and `http_requests_total{job="jcool-order"}` has `/orders` series for the SLO ([Deploy the monitoring stack](#deploy-the-monitoring-stack)).
8. **Unfreeze**, then check out at once through the public domain with a test account: `POST /orders`, `POST /orders/<id>/pay`, a Stripe test card, and the order reaches `PAID`; the confirmation mail arrives, and `t workflow describe --namespace jcool --workflow-id checkout-<order id>` reads `Completed`. If anything fails, freeze again, wait until no `CheckoutSaga` is `Running`, and fix forward or roll back (below).
9. After `CHECKOUT_INVARIANT_INTERVAL_MS` plus `CHECKOUT_INVARIANT_SETTLE_SEC`, `checkout_invariant_violations`, now scraped from `jcool-order`, reads 0 for every `kind`.

A run left waiting at steps 4 and 5, or cancelled, breaks nothing: production still runs the previous code and the freeze stays on, and the apply only added names that code ignores and deleted four it never reads. After a cancel, **Re-run all jobs** once `railway config plan --detailed-exit-code` exits 0.

**If Temporal stops during the window** (`CheckoutSagaEngineDown`, [Temporal down](#temporal-down)): the freeze still deploys, because the gateway's healthcheck goes to the api's readiness, which leaves Temporal out. Before the merge, the drain cannot be measured, so do not merge and do not unfreeze; bring Temporal back and continue from step 3. After the approval, CD stops at "Deploy order-service", whose readiness includes Temporal: production still runs the previous code and the freeze stays on. Bring Temporal back, then **Re-run all jobs**.

### Roll back the checkout cut-over

**If the order-service's deploy fails in CD**, before the api's, production still runs the previous code, which never reads the four deleted variables. Fix the order-service's variables (or bring Temporal back, as above) and **Re-run all jobs**; its plan has no destroy any more.

**Once the order-service and the new api are live**, roll back frozen, with no `CheckoutSaga` `Running` and `order-events` empty (the conditions of step 3). The rollback is a forward commit, never a `git revert` of the squash:

1. **Restore the api's previous wiring**: the order module, `shared/idempotency`, the `order-events` worker, the Temporal worker and client (the same workflow code and task queue; the api still has its `TEMPORAL_*` variables and its `node:24-slim` image), the in-process cart and catalog adapters with `CartModule`'s `CART_SNAPSHOT` export, the saga, participant and mail config with its env validation, the order retention sweeps, its `database.poolMax` override of 20 (10 + 2 + 2 + 5 = 19; without it env validation refuses to boot), and the shutdown steps with the Temporal worker. In `apps/api/package.json`, restore the `@temporalio/*` dependencies and the bundle step of `build` (`nest build && node dist/modules/order/infrastructure/temporal/bundle-checkout-saga-workflows.cli.js`). Nothing in CI notices a missing bundle, since the e2e setup bundles on its own and the api's readiness has no Temporal check; in production the worker logs `checkout saga worker cannot start without its bundle` and never polls. Send `/orders*` and `/admin/orders*` back to the api in `apps/gateway/Caddyfile` and `entrypoint.sh`, drop the "Deploy order-service" step from `cd.yml`, and restore the tests.
2. **Keep as merged**: `.railway/railway.ts` (`order-postgres`, `order-service`, the caller tokens, `ORDER_UPSTREAM`, `ORDER_TARGET`), every migration and `_journal.json`, `infra/prometheus`, and the freeze matcher. CD's plan is then empty. A plan with a destroy means the rollback commit is wrong; never approve a destroy for a rollback.
3. **Merge.** The api's readiness registers no Temporal check, so CD deploys the rollback, and the gateway redeploys for the freeze, while Temporal is down; checkout answers `503` until it is back, with the freeze kept on. The api's `drainingSeconds` was never lowered, so its 25000 shutdown fits.
4. **After CD and before unfreezing**, `railway down --service order-service` removes its running deployment and leaves the service, its variables and `order-postgres` alone. Then `t task-queue describe --task-queue checkout-saga --namespace jcool` must list a poller that is not `order-service@…` (the api's worker keeps the SDK's default identity, `<pid>@<hostname>`), and any `order-service@…` poller still listed must have its `lastAccessTime` stopped at the `railway down`. An empty list means the api's worker never started: stay frozen and read its logs. [OrderScrapeDown](#orderscrapedown) fires, as expected, until the forward fix; the saga alerts that join `up{job="jcool-order"}` stay silent meanwhile, so watch the saga through `checkout_sagas_open{job="jcool-api"}`.
5. **Unfreeze**, and check out once.

An order placed on the order-service, such as the test order of step 8, is not in the api's database; with demo data that is accepted.

---

## Standing exceptions

Anything here that suppresses a gate must carry an expiry date and an owner. An exception with no expiry is a decision nobody will revisit.

| Gate | Exception | Expires | Reason |
| ---- | --------- | ------- | ------ |
| — | none | — | `pnpm audit --prod --audit-level high` is clean as of 2026-09-18 |
