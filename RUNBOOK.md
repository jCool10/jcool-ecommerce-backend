# Runbook

Procedures an operator needs that the code cannot express on its own. Everything here is a manual
action with consequences — nothing in this file runs on a schedule.

Conventions used below:

- **local** — a developer machine with the repo, `npm ci` done, and `.env` pointing at the target.
- **container** — a shell inside the deployed image (`railway ssh --service "$RAILWAY_SERVICE"`),
  where `dist/` exists and `devDependencies` (including `tsx`) do **not**.

---

## Contents

- [Never rotate `IDENTITY_BUCKET_KEY`](#never-rotate-identity_bucket_key)
- [Backup and restore](#backup-and-restore)
- [Rebuild the search index](#rebuild-the-search-index)
- [Replay the dead-letter queue](#replay-the-dead-letter-queue)
- [Retention sweeps](#retention-sweeps)
- [A refund is owed](#a-refund-is-owed)
- [Apply migrations out of band](#apply-migrations-out-of-band)
- [Standing exceptions](#standing-exceptions)

---

## Never rotate `IDENTITY_BUCKET_KEY`

**This is not a policy, it is a one-way door.**

Every user-context id embeds a 12-bit routing bucket derived by HMAC from the account's normalized
email, under this key. The bucket is what a future `users` shard split routes on. Rotating the key
does not invalidate anything visibly — it mints *new* ids into buckets their emails no longer hash
to, and nothing reads a bucket until the split. The damage would surface years after the key that
caused it was lost.

The application defends this on every boot, in two layers
(`src/modules/user/infrastructure/identity-bucket-key.verifier.ts`):

1. **Row canary** — re-derives the bucket for the newest user row's email and compares it against
   the bucket in that row's id. Cannot catch a key that was wrong from row 1 (both sides then use
   the same wrong key).
2. **Key pin** — a fingerprint of the key stored in the database. Holds on a zero-row database, and
   survives a restore into an environment carrying a different key. Runs *after* the canary on
   purpose: the pin **writes**, so pinning first on a database that has rows but no pin would record
   a wrong key as the reference every later boot is held to.

Both **fail open** if the database is unreachable (no id is minted while it is down) and **fail
closed** only on a disagreement actually read back.

The first boot against an empty database logs the line that matters:

```
Pinned identity bucket key <fingerprint> — no key was pinned here before
```

**Record that fingerprint with the key.** It prints only on the boot that *writes* the pin; a boot
against an already-pinned database is silent.

### If a boot is refused

```
IDENTITY_BUCKET_KEY does not match the key this database was built with (pinned X, current Y)
```

There are exactly two correct responses:

- **Restore the original key** from the secret manager or the backup that holds it, and redeploy.
- **Reset the database**, if and only if it holds nothing worth keeping.

There is no third option. Do not delete the pin row to make the message go away: that removes the
only evidence of which key the existing ids were minted under, and the canary alone cannot rebuild
it.

---

## Backup and restore

The `IDENTITY_BUCKET_KEY` and the database are **one artifact**. Back them up together; a dump
without its key is a dump you cannot serve.

### Back up

```bash
# local — against whatever DATABASE_URL points at
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > backup-$(date +%Y%m%d-%H%M).dump
```

Then record, alongside the dump:

- the `IDENTITY_BUCKET_KEY` fingerprint (`SELECT fingerprint FROM identity_key_pin WHERE id = 1;`),
- which secret-manager entry holds the key itself.

### Restore

```bash
# local — into an EMPTY database
createdb jcool_restore
pg_restore --dbname="postgres://…/jcool_restore" --no-owner --no-privileges backup-….dump
```

Then boot the app against it **with the key that dump was taken under**.

### Restoring into an environment with a different key

The dump carries the `identity_key_pin` row, so the restored database still remembers the original
key's fingerprint. Booting the app against it under a different `IDENTITY_BUCKET_KEY` **refuses to
start** with the mismatch error above. That is the designed outcome — it is the check working, not
a restore problem.

Consequences to plan for:

- Restoring production data into staging requires **production's key** in staging, which usually
  means you should not be doing that. Prefer a seeded staging database.
- A dump restored into a database that already has a *different* pin row will fail on the primary
  key of `identity_key_pin` during `pg_restore`, not at boot. Restore into an empty database.
- Never "fix" a mismatch by updating `identity_key_pin`. Every existing id was minted under the
  pinned key; changing the pin makes the database lie about its own history.

---

## Rebuild the search index

`/products/search` reads a **derived** index. Postgres is the source of truth, so the index can
always be thrown away and rebuilt — it is never restored from a backup.

```bash
# local — requires SEARCH_ENABLED=true, SEARCH_URL and (if the engine is keyed) SEARCH_API_KEY
npm run search:reindex

# drop the index and rebuild it from scratch (schema/settings changes)
npm run search:reindex -- --reset
```

The command boots a **minimal** Nest context — config + database + the search adapter only — so no
queue consumers or scheduled sweeps run for its lifetime.

It refuses to run when `SEARCH_ENABLED` is not `"true"`, deliberately: the search adapter is a
silent no-op when search is off, so an unguarded rebuild would report success over an untouched
index. That is the one failure this command must never hide.

**Reindex is not part of deploy.** It is not in `preDeployCommand`, so a dead search engine still
lets a deploy through — the index is an extra read path, never a boot requirement. The cost is that
a shape change to the indexed document needs this run by hand afterwards.

---

## Replay the dead-letter queue

A message reaches the DLQ after `QUEUE_CONSUMER_ATTEMPTS` (default 8) deliveries fail. **Nothing
consumes the DLQ** — that is deliberate. A queue that drains itself hides the outage that filled it.

**Replay used to be unconditionally safe. It is not any more, and the tool now says so.** The old
guarantee was that a message goes back under its outbox row id, the inbox dedups on that id, and a
needless replay collapses into nothing. [Inbox retention](#retention-sweeps) ends it: once a claim
has been swept, "no claim" no longer means "never applied", and replaying such a message applies its
effect a second time.

So the CLI asks the database as well as Redis, and decides per message:

| Inbox claim for the message | Decision |
| --------------------------- | -------- |
| Present | **Refused, and `--force` cannot override it.** A replay would be a silent no-op you would read as a fix |
| Absent, `occurredAt` inside `RETENTION_INBOX_DAYS` | Replayed — the ordinary case |
| Absent, `occurredAt` older than that | Refused unless `--force`: the claim may simply have been swept |

The second and third rows turn on `occurredAt` — when the outbox row was written — and the choice of
field is the whole argument. What those rows must establish is not that the message is old but that
**if it had been applied, its claim would still be here to say so**. A claim is swept only once its
`processed_at` falls outside the window, and nothing can be processed before it was produced, so a
message born inside the window cannot have had a claim swept out from under it. Its absence is then
proof it was never applied.

`failedAt` cannot carry that argument and does not decide anything. It is re-stamped on every
dead-lettering, so it means "when it last failed" — a message applied a month ago and parked again
this morning carries a brand-new `failedAt` and a guard keyed on it would wave through exactly the
message most likely to have been swept. It is still printed in the refusal, because it is the
diagnosis you need in order to judge a `--force`.

**Before using `--force`**, establish by some other means that the effect never happened — the order
has no payment, the stock was never decremented, the email was never sent. `--force` is you
asserting that, not the tool checking it.

**Run it inside the deployed container**, via `queue:replay-dlq:prod`. The horizon comes from the
`RETENTION_INBOX_DAYS` of whatever environment the CLI process itself starts in, so running it from
a laptop whose `.env` omits the variable silently draws the window at the 30-day default while the
server may be keeping claims for seven — re-admitting precisely the replays the third row exists to
refuse. The window in force is echoed in the header the command prints; check it matches the
deployment before `--apply`.

What replay **cannot** fix in any case is the reason the message failed. Read the printed
`failedReason` and deploy the fix first, or the same messages come straight back.

```bash
# local — dry run is the default, because this puts real traffic back on a live queue
npm run queue:replay-dlq
npm run queue:replay-dlq -- --apply
npm run queue:replay-dlq -- --apply --limit 20
npm run queue:replay-dlq -- --apply --force   # past the retention horizon; read above first
```

```bash
# container — same tool, compiled. `tsx` is a devDependency and is not installed here.
npm run queue:replay-dlq:prod
npm run queue:replay-dlq:prod -- --apply
```

The guard runs on a dry run too, so the listing is what `--apply` would actually do rather than a
promise it would then refuse.

The CLI reads its Redis URL, queue prefix **and inbox window** through the app's own config factory
rather than re-reading the environment, so it cannot report a reassuringly empty queue by looking
under a different prefix than the app writes to, nor draw the horizon in a different place than the
sweep does. It boots no Nest context at all — a replay is something you want to be able to run while
the app itself is the thing that is broken. It now needs **Postgres as well as Redis**: the inbox
check is not optional, so a replay cannot be performed while the database is down.

---

## Retention sweeps

One timer (`RETENTION_INTERVAL_MS`, hourly by default) drives seven independent sweeps, each
reclaiming one table. Failures, timeouts and the "still running" guard are **per sweep**: one broken
table cannot cost the other six their tick.

Every window is sized by **what still has to be able to retry against the row**, never by disk.
Shortening one does not lose history; it loses a guarantee, and only under retry — which is to say
only during an incident.

| Sweep | Table | Collected when | Never collected | Env var |
| ----- | ----- | -------------- | --------------- | ------- |
| `messaging:outbox` | `outbox` | `published_at` older than the window | **Any row with `published_at IS NULL`, at any age** — that is an unsent event, not a stale record | `RETENTION_OUTBOX_DAYS` (30) |
| `messaging:inbox` | `inbox` | `processed_at` older than the window | — | `RETENTION_INBOX_DAYS` (30, floor 7) |
| `order:idempotency-keys` | `idempotency_keys` | `expires_at` past, plus a grace | Anything still inside its TTL, **`COMPLETED` included** — that row is the response a retry replays | `RETENTION_IDEMPOTENCY_GRACE_SEC` (3600) |
| `payment:webhook-events` | `webhook_events` | `received_at` older than the window | — | `RETENTION_WEBHOOK_EVENT_DAYS` (30, floor 14) |
| `auth-tokens:email-verification` | `email_verification_tokens` | expired, or consumed, longer ago than the grace | A token that can still be spent | `RETENTION_AUTH_TOKEN_GRACE_DAYS` (7) |
| `auth-tokens:password-reset` | `password_reset_tokens` | same | same | `RETENTION_AUTH_TOKEN_GRACE_DAYS` (7) |
| `auth-tokens:refresh` | `refresh_tokens` | expired past the token grace **and never revoked**, or revoked past the refresh grace | A revoked token inside its own, much longer grace — whether or not it has also expired | `RETENTION_REFRESH_TOKEN_GRACE_DAYS` (30, floor 30) |

`reservations` is deliberately **not** in this list. Those rows are released by the reservation
expiry sweep, which is a state machine driving stock back to available — not retention.

### The two horizons that are not preferences

**Inbox.** `RETENTION_INBOX_DAYS` must exceed how long the queue can still redeliver a message:

```
RETENTION_INBOX_DAYS × 86400  >  REMOVE_ON_FAIL_AGE_SEC   (604800, i.e. 7 days)
```

A failed job is re-runnable for exactly that long. Sweep its claim first and the re-run is
indistinguishable from a first delivery — the effect is applied twice, silently. **The app refuses
to boot** on a value that violates this, with the arithmetic in the error. The dead-letter queue has
no age limit at all and so no comparable bound, which is why the DLQ side is handled at replay time
by querying the inbox rather than by a clock.

**Revoked refresh tokens.** Expiry is age; revocation is evidence. A revoked row is what reuse
detection matches an incoming token against, so collecting it on the expiry clock turns a detected
replay — the signal that a refresh token leaked — back into a successful refresh. Hence a separate
grace, an order of magnitude longer, with a 30-day floor in env validation.

The subtle part is that the expiry arm is restricted to rows that were **never** revoked. Every
rotation revokes its predecessor, so a rotated token carries both timestamps, and `rotate` checks
revoked-or-replaced *before* it checks expiry precisely so an expired-but-retired token coming back
still reads as reuse. An expiry arm that ignored `revoked_at` would therefore collect rotated tokens
on the short clock: at the default 7-day TTL and 7-day expiry grace they would go at about day 14,
and the 30-day floor above would be fiction for every token that had ever been rotated. If you widen
`RETENTION_AUTH_TOKEN_GRACE_DAYS`, that arm still only touches tokens that died of old age unused.

### What to watch

| Signal | Means |
| ------ | ----- |
| `retention_rows_deleted_total{sweep}` flat | Either nothing to collect **or** the sweep is not running. The failure counter is what tells the two apart |
| `retention_sweep_failures_total{sweep}` rising | That one table is not being reclaimed. Per label — it says nothing about the other six |
| `retention sweep filled its batch` (warn) | The batch is a cap, so a full one means there was more to give. Once is a backlog being worked off; every tick forever means rows arrive faster than this reclaims them and the table grows *despite* the sweep. Raise `RETENTION_BATCH_SIZE`, shorten the window, or shorten the interval |
| `previous retention sweep still running` (warn) | One sweep is exceeding `RETENTION_SWEEP_TIMEOUT_MS`. The timeout ends the *wait*, not the DELETE, so the statement is still holding locks somewhere |

Every log line from a sweep carries a `requestId` and a `job` of `retention:<sweep name>` — one
correlation id per sweep, not per tick, because a retention question is about one table at a time.

### Query plans

Measured 2026-09-07 on Postgres 16, 200k rows per table, seeded to resemble a table that has been
running for months. The case that matters is the **steady state** — the backlog worked off, almost
nothing old enough to collect — because that is what runs on 23 of every 24 ticks, and it is the
case where `LIMIT` cannot help: the scan has nothing to find early.

| Sweep | Plan | Time |
| ----- | ---- | ---- |
| `messaging:outbox` | Index Scan `idx_outbox_published` | 0.04 ms |
| `messaging:inbox` | Index Scan `idx_inbox_processed` | 0.01 ms |
| `order:idempotency-keys` | Index Scan `idx_idempotency_expires` | 0.01 ms |
| `payment:webhook-events` | Index Scan `idx_webhook_events_received` | 0.01 ms |
| `auth-tokens:email-verification` | BitmapOr of `_expires` + `_consumed` | 0.02 ms |
| `auth-tokens:password-reset` | BitmapOr of `_expires` + `_consumed` | 0.02 ms |
| `auth-tokens:refresh` | BitmapOr of `_expires` + `_revoked` | 0.09 ms |

The three disjunctive predicates need **both** arms indexed or neither index is used. Measured with
only one arm indexed, `email_verification_tokens` fell back to a parallel seq scan at 22 ms and
`password_reset_tokens` to 15 ms — costs that grow with exactly the thing the sweep exists to bound.
That is what migration 0018 is for; do not drop half a pair.

An index also has to match its arm's **whole** predicate, not just its column. `idx_refresh_tokens_expires`
is partial on `revoked_at IS NULL` because that is the arm it serves; as a plain index on `expires_at`
it measured a 41 ms seq scan on the same 200k rows, since on a mature table nearly every expired row
has also been revoked and the index hands the planner a match list that is almost all rejects.

When a sweep is actively working off a backlog the planner correctly prefers a seq scan instead: it
finds 500 matching rows within the first few pages and stops. Both shapes are healthy.

---

## A refund is owed

`payment_refund_owed_total` rising means money reached a buyer's payment for an order that will not
be fulfilled. **This service does not refund anything automatically** — automatic refunds are out of
scope — so every increment is a person's job, and nothing retries it away.

How it happens: an order dies unpaid (a cancel, or the TTL sweep) while the buyer still has the
hosted checkout page open, and they pay on it. Stock has already been released and possibly resold;
the money has not been.

The counter counts **observations, not refunds.** One stranded payment is normally seen twice —
usually `expire_session` first, then `webhook_direct` — so do not read the unlabelled total as a
count of buyers. The label names the path that noticed, not a separate incident.

| `source` | Who saw it |
| -------- | ---------- |
| `expire_session` | Closing the checkout session failed because it had already taken money (`ExpirePaymentSession`) |
| `webhook_direct` | The gateway's webhook settled a payment and found the order already terminal (`HandlePaymentWebhook`) |
| `settlement_event` | The durable half of the same webhook, re-run through the queue (`PaymentEventsHandler`) |

To act on one, find the order: every source logs at `error` with `orderId` and, for the first two,
`paymentId`. Then read the money and the order side back —

```sql
SELECT o.id, o.status, o.finalize_reason, o.total_amount,
       p.id AS payment_id, p.status AS payment_status, p.provider_session_id, p.provider_intent_id
FROM orders o JOIN payments p ON p.order_id = o.id
WHERE o.id = '<orderId>';
```

An order in `CANCELLED` / `EXPIRED` / `FAILED` carrying a `SUCCEEDED` payment is owed a refund.
Refund `provider_intent_id` in the gateway's own dashboard; the order and the stock are already
correct and must not be edited to match. If the order reads `PAID`, nothing is owed — the settlement
won the race after all, and the alarm was a second observation of an order that resolved itself.

**`payment_status = PENDING` does not mean nothing is owed.** The `expire_session` path deliberately
leaves the row `PENDING`: it learned about the money from the gateway refusing to close the session,
not from a settlement, and it must not fabricate one. If the webhook is late or lost, `PENDING` is
all the database will ever say. For that source the authority is the session itself — read
`provider_session_id` in the gateway dashboard:

- `payment_status = paid` → the money landed. **Refund owed**, from the session's payment intent.
- `status = complete`, `payment_status = unpaid` → an asynchronous method is still clearing. Nothing
  is owed *yet*; re-check later, or wait for `async_payment_failed`, which means nothing was ever
  taken.
- `status = expired` → the close did land after all. Nothing owed.

To find every candidate rather than chase one log line — orders that died holding money that was
never resolved:

```sql
SELECT o.id, o.status, o.finalize_reason, p.status AS payment_status,
       p.provider_session_id, p.provider_intent_id, o.updated_at
FROM payments p JOIN orders o ON o.id = p.order_id
WHERE o.status IN ('CANCELLED', 'EXPIRED', 'FAILED')
  AND p.status IN ('PENDING', 'SUCCEEDED')
ORDER BY o.updated_at DESC;
```

`SUCCEEDED` rows there are owed refunds outright. `PENDING` rows need the session check above; most
are the ordinary case of a buyer who simply never paid, and their sessions read `expired`.

---

## Apply migrations out of band

Railway runs `npm run db:migrate:prod` as `preDeployCommand`, so the normal path needs no operator.
Run it by hand only when a deploy failed *after* the image built but before migrations applied, or
when restoring.

```bash
# container
npm run db:migrate:prod
```

```bash
# local — drizzle-kit, reads drizzle.config.ts
npm run db:migrate
```

The compiled CLI fails loudly if its migrations directory resolves to a readable but wrong path:
a directory with zero `.sql` files would otherwise make drizzle report "nothing pending" and exit 0
— a green deploy onto an empty schema. In the image `MIGRATIONS_DIR=/app/migrations`, absolute
because the image ships no `src/` tree.

**Run exactly one migration process at a time.** `runMigrations()` takes no advisory lock, so two
concurrent runs race on `__drizzle_migrations`. This is why there is a single deployable service.

---

## Standing exceptions

Anything here that suppresses a gate must carry an expiry date and an owner. An exception with no
expiry is a decision nobody will revisit.

| Gate | Exception | Expires | Reason |
| ---- | --------- | ------- | ------ |
| — | none | — | `npm audit --omit=dev --audit-level=high` is clean as of 2026-09-07 |
