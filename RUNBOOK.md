# Runbook

Procedures an operator needs that the code cannot express on its own. Everything here is a manual
action with consequences — nothing in this file runs on a schedule.

Two deployables ship from one image: **commerce-core** and **user-service**. They have separate
Postgres instances and share one Redis. Which service a procedure runs against is stated wherever it
matters; where it is not stated, the procedure is the same on both.

Conventions used below:

- **local** — a developer machine with the repo, `npm ci` done, and `.env` (commerce-core) or
  `.env.user` (user-service) pointing at the target.
- **container** — a shell inside the deployed image (`railway ssh --service "$RAILWAY_SERVICE"`),
  where `dist/` exists and `devDependencies` (including `tsx`) do **not**.

---

## Contents

- [Two databases, one Redis](#two-databases-one-redis)
- [Never rotate `IDENTITY_BUCKET_KEY`](#never-rotate-identity_bucket_key)
- [Rotate the JWT signing key](#rotate-the-jwt-signing-key)
- [Sessions depend on Redis](#sessions-depend-on-redis)
- [Backup and restore](#backup-and-restore)
- [Split the user service off](#split-the-user-service-off)
- [Rebuild the search index](#rebuild-the-search-index)
- [Reconcile the bucket against `media_assets`](#reconcile-the-bucket-against-media_assets)
- [Outbox relay is not draining](#outbox-relay-is-not-draining)
- [Replay the dead-letter queue](#replay-the-dead-letter-queue)
- [Retention sweeps](#retention-sweeps)
- [A refund is owed](#a-refund-is-owed)
- [Apply migrations out of band](#apply-migrations-out-of-band)
- [Standing exceptions](#standing-exceptions)

---

## Two databases, one Redis

Postgres is split; Redis is not. Neither service can reach the other's database — there is no
connection string for it and no HTTP call between them — so **everything the two share is a Redis
key**, and that list is short enough to hold in your head:

| Key | Written by | Read by | If it disappears |
| --- | ---------- | ------- | ---------------- |
| `auth:epoch:{sub}` | user-service | **both** | Affected tokens 401 until a refresh republishes the key. Self-healing, see below |
| `auth:denylist:{jti}` | user-service | **both** | A logged-out access token is honoured again for the rest of its `JWT_ACCESS_TTL` |

Everything else is single-owner and must stay that way:

| Prefix | Owner | Notes |
| ------ | ----- | ----- |
| `catalog:v2:*` | commerce-core | Product cache and its generation counter. `catalog:v2:ver` carries no TTL — see `catalog-cache.keys.ts` |
| `${QUEUE_PREFIX}` (`bull` by default) | commerce-core | BullMQ. user-service boots no queue at all; a `bull*` key appearing after a user-service-only deploy means a messaging module was wired back in |
| throttler counters (`@nest-lab/throttler-storage-redis`) | one store, disjoint keys | Both apps write here, but a key is hashed from the controller class and handler name as well as the tracker, so no counter is ever shared: a flood on `/auth/login` does not spend `/products`' budget. Short TTLs, nothing to clean up |

### Audit the keyspace

Run after any deploy that moved a module between services, and whenever a key is suspected of
leaking across the boundary:

```bash
# container / local — needs redis-cli against REDIS_URL
redis-cli --scan --count 1000 | sed -E 's/[0-9a-f-]{8,}.*//' | sort | uniq -c | sort -rn
```

The output is a namespace census, not a key list — the trailing id of every per-entity key is
stripped. What you are looking for is a prefix that should not be there:

- a `bull*` prefix while only user-service has deployed,
- an `auth:epoch:` or `auth:denylist:` key when user-service is **not** running (nothing else mints
  them; a stale one is a leftover, harmless, and expires),
- any prefix in the single-owner table above appearing in a window when only its non-owner ran.

Two services on one Redis also means `FLUSHALL` is never a per-service action. It drops the catalog
cache and every live session projection at once.

---

## Never rotate `IDENTITY_BUCKET_KEY`

**This is not a policy, it is a one-way door.**

Every user-context id embeds a 12-bit routing bucket derived by HMAC from the account's normalized
email, under this key. The bucket is what a future `users` shard split routes on. Rotating the key
does not invalidate anything visibly — it mints *new* ids into buckets their emails no longer hash
to, and nothing reads a bucket until the split. The damage would surface years after the key that
caused it was lost.

The key belongs to **user-service** and to no other process: it is the only service that mints ids,
and it is the only one that holds the key. commerce-core stores user ids it was handed and never
derives one.

The application defends this on every boot, in two layers
(`apps/user/src/modules/user/infrastructure/identity-bucket-key.verifier.ts`):

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

## Rotate the JWT signing key

Unlike `IDENTITY_BUCKET_KEY`, this key is rotatable — nothing persistent was minted under it. Access
tokens are ES256 and carry a `kid`; verifiers select the key by that `kid`, so a rotation is additive
and needs no coordinated restart.

There is exactly one issuer — **user-service** — and two verifiers: user-service itself and
commerce-core. Only the issuer gets `JWT_ES256_PRIVATE_KEY`; commerce-core is configured with the
public half alone, which is what makes "core cannot mint a token" a fact about its environment
rather than a convention.

Generate a pair (the private half never leaves the issuing service):

```bash
openssl ecparam -name prime256v1 -genkey -noout -out jwt-es256.key
openssl ec -in jwt-es256.key -pubout -out jwt-es256.pub
base64 < jwt-es256.key   # JWT_ES256_PRIVATE_KEY
base64 < jwt-es256.pub   # JWT_ES256_PUBLIC_KEY
```

Order matters, and only the first step is urgent:

1. Add the new public key to **every** verifier under a new `kid`, alongside the current one — that
   is **both** services (`libs/auth/src/jwt.strategy.ts` builds that map — today it holds one entry,
   and a rotation is where the second appears). Deploy both. Nothing changes yet: no token carries
   the new `kid`.
2. Point user-service at the new private key and `JWT_KEY_ID`. Deploy. New tokens verify against the
   new entry; outstanding ones still match the old.
3. Wait one `JWT_ACCESS_TTL` (default 5m), then drop the old public key.

Rotating in the other order — issuing before every verifier knows the `kid` — rejects every token
minted in the gap. Compromise is the one case worth that: swap the private key immediately, accept
the 401s, and let clients refresh. With two deployables the gap is a deploy apart rather than a
restart apart, so step 1 must be confirmed live on commerce-core before step 2 starts.

---

## Sessions depend on Redis

Every authenticated request reads Redis twice: the `auth:denylist:{jti}` key (already true before
the epoch projection) and `auth:epoch:{sub}`. **Redis being down means requests are rejected, not
served stale.** That is deliberate — a missing epoch is indistinguishable from a revoked session,
and guessing costs a logout-all its meaning.

`users.token_epoch` — in **user-service's** Postgres — is the source of truth; `auth:epoch:{sub}` is
a projection written on every mint and every bump. commerce-core reads the projection and has no
path to the row behind it, so a projection problem is diagnosed on user-service and *felt* on
commerce-core. Consequences to know before diagnosing:

- **A lost keyspace is self-healing.** Missing keys 401 the affected tokens, the clients refresh, and
  refresh republishes. Expect a burst of `auth_epoch_projection_miss_total` and no action needed —
  the `AuthEpochProjectionMissing` alert deliberately ignores a burst and fires only on a rate that
  will not settle.
- **A crash between the Postgres bump and the Redis write leaves a window of one `JWT_ACCESS_TTL`**
  in which already-minted tokens still pass. It is bounded and it is not fixed: closing it means a
  distributed transaction across two stores for a five-minute exposure on a revocation the user
  already believes happened.
- **`auth_epoch_projection_write_failure_total` climbing without a Redis outage** means the writer is
  failing on its own — it never throws, by design, so nothing else will tell you. The series is
  exported by `jcool-user` only; it does not exist on `jcool-api`.

---

## Backup and restore

Two databases, backed up separately, and only one of them is coupled to a secret: the
`IDENTITY_BUCKET_KEY` and **user-service's** database are one artifact, and a dump without its key
is a dump you cannot serve. commerce-core's database has no such pairing.

They are also not consistent with each other at any instant — no distributed snapshot exists — so a
restore of both to the same wall-clock time can leave commerce-core holding an order for a user id
user-service's dump does not have. Orders snapshot the buyer's email at checkout precisely so that
row is still readable; treat the mismatch as expected, not as corruption.

### Back up

```bash
# local — one per service
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL"      > core-$(date +%Y%m%d-%H%M).dump
pg_dump --format=custom --no-owner --no-privileges "$USER_DATABASE_URL" > user-$(date +%Y%m%d-%H%M).dump
```

Then record, alongside the **user** dump:

- the `IDENTITY_BUCKET_KEY` fingerprint
  (`psql "$USER_DATABASE_URL" -c 'SELECT fingerprint FROM identity_key_pin WHERE id = 1;'`),
- which secret-manager entry holds the key itself.

### Restore

```bash
# local — into an EMPTY database, one per service
createdb jcool_restore
pg_restore --dbname="postgres://…/jcool_restore" --no-owner --no-privileges core-….dump
```

Then boot the service against it — user-service **with the key that dump was taken under**.

### Restoring into an environment with a different key

Applies to the **user** dump only — `identity_key_pin` lives in user-service's database.

The dump carries the `identity_key_pin` row, so the restored database still remembers the original
key's fingerprint. Booting user-service against it under a different `IDENTITY_BUCKET_KEY`
**refuses to start** with the mismatch error above. That is the designed outcome — it is the check working, not
a restore problem.

Consequences to plan for:

- Restoring production data into staging requires **production's key** in staging, which usually
  means you should not be doing that. Prefer a seeded staging database.
- A dump restored into a database that already has a *different* pin row will fail on the primary
  key of `identity_key_pin` during `pg_restore`, not at boot. Restore into an empty database.
- Never "fix" a mismatch by updating `identity_key_pin`. Every existing id was minted under the
  pinned key; changing the pin makes the database lie about its own history.

---

## Split the user service off

A one-time migration of five tables out of commerce-core's database and into user-service's. It is
run once per environment and is **not** a deploy step — the code ships first and does nothing until
the rows move.

Two facts make it survivable:

- `orders.user_id` has never had a foreign key to `users`, and orders snapshot the buyer's email at
  checkout. Nothing in commerce-core needs the rows after the move.
- Commerce-core migration `0022_drop_user_tables` is what makes the move irreversible, and it is in
  the journal. **Do not deploy commerce-core past 0021 until step 6 has passed.** Until then the old
  tables are still sitting there and the whole procedure rolls back by pointing `/auth` at the old
  origin again.

The refresh cookie is `path=/auth` on whichever origin issued it. Moving `/auth` to a different
origin invalidates every session that existed before the switch: **everyone logs in once more.**
Plan the window around that, not around the dump.

### 1. Freeze writes to the five tables

Stop the old `/auth` — take commerce-core's auth routes out of the router, or scale the old service
to zero. A register or a refresh landing between the dump and the switch is a row that exists in
neither database afterwards. Reads elsewhere are unaffected; carts and checkout do not touch these
tables.

### 2. Dump the five tables

```bash
# local — from commerce-core's database
pg_dump --format=custom --no-owner --no-privileges \
  -t users -t refresh_tokens -t email_verification_tokens -t password_reset_tokens \
  -t identity_key_pin \
  "$DATABASE_URL" > user-tables-$(date +%Y%m%d-%H%M).dump
```

`identity_key_pin` is not optional. It is the fingerprint of the `IDENTITY_BUCKET_KEY` every
existing id was minted under; leaving it behind lets user-service pin a *different* key on its first
boot and record it as the reference every later boot is held to.

### 3. Create the target schema, then restore into it

```bash
npm run db:migrate:prod:user                       # baseline: the five tables, empty
pg_restore --dbname="$USER_DATABASE_URL" --no-owner --no-privileges \
  --data-only --disable-triggers user-tables-….dump
```

`--data-only` because the journal already created the tables — restoring the schema too would fail
on objects that exist. If it fails on the `role` enum, the baseline did not run; do not create the
type by hand.

### 4. Verify row counts match

```bash
for t in users refresh_tokens email_verification_tokens password_reset_tokens identity_key_pin; do
  printf '%-28s %8s %8s\n' "$t" \
    "$(psql -tAc "select count(*) from $t" "$DATABASE_URL")" \
    "$(psql -tAc "select count(*) from $t" "$USER_DATABASE_URL")"
done
```

Every row must be equal. A short `refresh_tokens` is a set of sessions that will 401 on their next
refresh; a short `users` is accounts that no longer exist.

### 5. Verify the ids still route

```bash
# local — with USER_DATABASE_URL and the ORIGINAL IDENTITY_BUCKET_KEY
npm run identity:verify
```

This re-derives each user's routing bucket from their email and compares it against the bucket
embedded in their id. A mismatch here means the key in this environment is not the key the ids were
minted under — **stop**, and read
[Never rotate `IDENTITY_BUCKET_KEY`](#never-rotate-identity_bucket_key). Do not continue and do not
"fix" `identity_key_pin`.

### 6. Boot user-service and switch the route

Start user-service against the restored database — the key pin check runs on boot and is a second,
independent confirmation of step 5 — then point `/auth/*` at it and lift the freeze.

Watch for one `JWT_ACCESS_TTL`:

- `auth_epoch_projection_miss_total` — a burst is expected and self-healing; a rate that will not
  settle is not,
- 401s on commerce-core routes, which would mean the two services disagree about `JWT_KEY_ID` or the
  public key.

### 7. Only then, drop the old tables

Deploy commerce-core with `0022_drop_user_tables`. From here the move is one-way: reverting means
restoring commerce-core's database from a backup taken before this step.

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

## Reconcile the bucket against `media_assets`

Stores that must agree and cannot all be kept in one transaction. Three ways they can disagree:

```bash
# local — needs DATABASE_URL and the four STORAGE_* settings
npm run storage:verify

# narrow the scan
npm run storage:verify -- --prefix media/ --limit 5000

# container — the compiled twin, since `tsx` is a devDependency and is not installed there
npm run storage:verify:prod
```

**Read-only. It deletes nothing**, and that is deliberate: what to do differs per direction, and
neither answer is safe for a script to guess. It exits `1` when anything is found, so a scheduled run
fails loudly.

| Finding | Means | Do |
| ------- | ----- | -- |
| **orphan object** — bytes in the bucket no row points at | Storage being paid for with nothing left that could ever reference it. Either a `PUT` that landed after its row was swept, or bytes written to the bucket outside the app. **Not** a crashed sweep: that deletes the object first and the row second, so it leaves a `SWEEPING` row whose object is gone — a state this tool does not report at all | Delete the object by hand; no row exists for a sweep to ever claim it, so re-running changes nothing. It is not a scan artefact either — candidates are re-read against the database before being reported |
| **missing object** — an `ATTACHED` row whose object is gone | A product is rendering a broken image **right now**, and bytes were deleted while something still pointed at them. Never expected | Detach the image (`DELETE /admin/products/:productId/images/:imageId`) so the page stops breaking, then re-upload. Find out what deleted it — the sweep cannot select an `ATTACHED` row |
| **dangling link** — a `product_images` row whose `media_assets` row is gone | There is no FK between them (separate contexts), and the read path *hides* this: an asset id that resolves to no URL is dropped from the response rather than rendered broken | Detach the image, then re-upload. The product visibly loses an image, but nothing anywhere raises an error about it — this table is the only place it is reported |

It boots no Nest context at all — it needs only Postgres and the bucket, and it is most useful when
the app is what is suspect.

### CORS, content sniffing and downloads are bucket configuration, not app code

The app signs `Content-Type` on upload and stores only what the allowlist permits, so nothing else
can be written *through* it. What it does **not** control is anything the browser does directly
against the bucket. Three settings belong on the bucket or the CDN in front of it, and the first one
is not optional:

- **CORS**, allowing `PUT` from the admin origin with `Content-Type` among the permitted request
  headers — that header is the whole of what the preflight has to clear, since the signature travels
  in the query string and no `Authorization` header is sent. Without it the design fails in exactly
  one environment: `curl` uploads fine, the browser's preflight is refused, and "the client writes
  straight to the bucket" is false in the only place it matters. Nothing in this repo provisions it —
  set it when the bucket is created.
- **`X-Content-Type-Options: nosniff`** — without it a browser may sniff past the stored
  `Content-Type`, and a file that was uploaded as an image but parses as markup can execute on the
  bucket's origin.
- **`Content-Disposition: attachment`** (or a bucket domain isolated from the app's) — so a direct
  object URL downloads rather than renders in a context that shares an origin with anything.

None of the three can be enforced from this codebase; they belong in the bucket/CDN policy, and the
last two are why `STORAGE_PUBLIC_BASE_URL` should point at a domain that hosts nothing else.

---

## Outbox relay is not draining

`OutboxMessageStale` pages on `outbox_oldest_age_seconds > 60`. The gauge is an **age**, so one row
that can never publish pins it forever and looks identical to a relay that stopped — but the two
need opposite responses. `attempts` is what separates them:

```sql
-- local — the oldest unpublished rows and how often each has been refused
SELECT id, event_type, attempts, created_at
FROM outbox
WHERE published_at IS NULL
ORDER BY created_at, id
LIMIT 20;
```

- **`attempts` climbing on one row while others publish** — that row is poison, and the backlog
  behind it is moving. The relay only charges an attempt when something else in the same tick got
  through, so a non-zero count is proof the queue itself is healthy. Fix the payload or the handler;
  the row keeps its place in line meanwhile.
- **`attempts` flat at 0 across the whole backlog** — nothing is publishing. Either the relay is not
  running (`QUEUE_ENABLED`, the worker process) or Redis is refusing every publish. Check
  `outbox_backlog_pending` alongside it: a deep backlog with a flat age is a burst being worked
  through, not an outage.

A row here has **not** been dead-lettered — it was never delivered at all, so
[replay](#replay-the-dead-letter-queue) does not apply to it and there is nothing to re-admit.

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

What replay **cannot** fix in any case is the reason the message failed. Each line prints it as
`[parked: <reason>]`; deploy the fix first, or the same messages come straight back.

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

Eight sweeps, each reclaiming one table, split across the two services by which database holds the
table: **five on commerce-core, three on user-service**. Each service runs its own timer
(`RETENTION_INTERVAL_MS`, hourly by default) over its own sweeps, so the grace variables below are
read from whichever `.env` owns that sweep and setting one on the wrong service does nothing at all.
Failures, timeouts and the "still running" guard are **per sweep**: one broken table cannot cost the
others their tick.

Every window is sized by **what still has to be able to retry against the row**, never by disk.
Shortening one does not lose history; it loses a guarantee, and only under retry — which is to say
only during an incident.

| Sweep | Service | Table | Collected when | Never collected | Env var |
| ----- | ------- | ----- | -------------- | --------------- | ------- |
| `messaging:outbox` | core | `outbox` | `published_at` older than the window | **Any row with `published_at IS NULL`, at any age** — that is an unsent event, not a stale record | `RETENTION_OUTBOX_DAYS` (30) |
| `messaging:inbox` | core | `inbox` | `processed_at` older than the window | — | `RETENTION_INBOX_DAYS` (30, floor 7) |
| `order:idempotency-keys` | core | `idempotency_keys` | `expires_at` past, plus a grace | Anything still inside its TTL, **`COMPLETED` included** — that row is the response a retry replays | `RETENTION_IDEMPOTENCY_GRACE_SEC` (3600) |
| `payment:webhook-events` | core | `webhook_events` | `received_at` older than the window | — | `RETENTION_WEBHOOK_EVENT_DAYS` (30, floor 14) |
| `auth-tokens:email-verification` | **user** | `email_verification_tokens` | expired, or consumed, longer ago than the grace | A token that can still be spent | `RETENTION_AUTH_TOKEN_GRACE_DAYS` (7) |
| `auth-tokens:password-reset` | **user** | `password_reset_tokens` | same | same | `RETENTION_AUTH_TOKEN_GRACE_DAYS` (7) |
| `auth-tokens:refresh` | **user** | `refresh_tokens` | expired past the token grace **and never revoked**, or revoked past the refresh grace | A revoked token inside its own, much longer grace — whether or not it has also expired | `RETENTION_REFRESH_TOKEN_GRACE_DAYS` (30, floor 30) |
| `media:assets` | core | `media_assets` **and the objects behind them** | `expires_at` past, or a `SWEEPING` claim older than `RETENTION_SWEEP_TIMEOUT_MS` | **Anything `ATTACHED`** — those rows have no `expires_at` at all, so no query the sweep can write will match them | `MEDIA_UPLOAD_TTL_SEC` (3600) / `MEDIA_READY_TTL_SEC` (86400) |

`media:assets` is the only sweep that deletes something outside Postgres, and the only one whose work
is not undoable by restoring a backup. It deletes **the object first, then the row**: a crash between
the two leaves a row whose object is gone, which the next pass re-scans and finishes (deleting an
absent object is a no-op). The reverse order would leave bytes nothing points at — unfindable and
billed forever. If a pass dies mid-flight the claim is left at `SWEEPING`, and a claim older than the
sweep's own timeout is assumed dead and picked up again.

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
| `retention_sweep_failures_total{sweep}` rising | That one table is not being reclaimed. Per label — it says nothing about the others |
| `media_assets_sweeping` above zero and staying there | The media sweep is claiming rows but its bucket deletes are failing. The objects behind those rows are still being paid for; check storage credentials and endpoint reachability |
| `retention sweep filled its batch` (warn) | The batch is a cap, so a full one means there was more to give. Once is a backlog being worked off; every tick forever means rows arrive faster than this reclaims them and the table grows *despite* the sweep. Raise `RETENTION_BATCH_SIZE`, shorten the window, or shorten the interval |
| `previous retention sweep still running` (warn) | One sweep is exceeding `RETENTION_SWEEP_TIMEOUT_MS`. The timeout ends the *wait*, not the DELETE, so the statement is still holding locks somewhere |

Every log line from a sweep carries a `requestId` and a `job` of `retention:<sweep name>` — one
correlation id per sweep, not per tick, because a retention question is about one table at a time.

The `retention_*` series come from two scrape targets: the five core sweeps under `job="jcool-api"`,
the three `auth-tokens:*` sweeps under `job="jcool-user"`. A query without a `job` matcher spans
both, which is usually what you want; a dashboard that pins the wrong job silently shows nothing.

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
Both arms of each pair are in user-service's baseline migration; do not drop half a pair.

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

Two journals, two commands, two databases — never one command for both. Each service runs its own as
`preDeployCommand`, so the normal path needs no operator. Run one by hand only when a deploy failed
*after* the image built but before migrations applied, or when restoring.

```bash
# container
npm run db:migrate:prod        # commerce-core → DATABASE_URL,      apps/commerce-core/migrations
npm run db:migrate:prod:user   # user-service  → USER_DATABASE_URL, apps/user/migrations
```

```bash
# local — drizzle-kit, reads the per-app config
npm run db:migrate
npm run db:migrate:user
```

The compiled CLI takes the target as its argv (`migrate-cli.js commerce-core|user`) and picks the
folder and connection variable from it, so there is no environment in which running the wrong one
silently applies the wrong journal: an unknown target, a missing URL, or a folder with zero `.sql`
files each exits 1 with a named message. The zero-file check is the one that matters — drizzle would
otherwise report "nothing pending" and exit 0, a green deploy onto an empty schema. In the image the
paths are absolute (`MIGRATIONS_DIR=/app/migrations/commerce-core`,
`USER_MIGRATIONS_DIR=/app/migrations/user`) because it ships no `src/` tree.

**Run exactly one migration process per database at a time.** `runMigrations()` takes no advisory
lock, so two concurrent runs race on `__drizzle_migrations`. The two services never race with each
other — separate databases, separate journals — but two instances of the *same* service do, which is
why each `preDeployCommand` must be a single-replica step.

---

## Standing exceptions

Anything here that suppresses a gate must carry an expiry date and an owner. An exception with no
expiry is a decision nobody will revisit.

| Gate | Exception | Expires | Reason |
| ---- | --------- | ------- | ------ |
| — | none | — | `npm audit --omit=dev --audit-level=high` is clean as of 2026-09-07 |
