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

Replay is safe for a message that turned out to have been applied after all: it is re-published
under the outbox row id, which is the key the inbox dedups on, so the worst case is one collapsed
duplicate. What replay **cannot** fix is the reason the message failed. Read the printed
`failedReason` and deploy the fix first, or the same messages come straight back.

```bash
# local — dry run is the default, because this puts real traffic back on a live queue
npm run queue:replay-dlq
npm run queue:replay-dlq -- --apply
npm run queue:replay-dlq -- --apply --limit 20
```

```bash
# container — same tool, compiled. `tsx` is a devDependency and is not installed here.
npm run queue:replay-dlq:prod
npm run queue:replay-dlq:prod -- --apply
```

The CLI reads its Redis URL and queue prefix through the app's own config factory rather than
re-reading the environment, so it cannot report a reassuringly empty queue by looking under a
different prefix than the app writes to. It boots no Nest context at all — a replay is something
you want to be able to run while the app itself is the thing that is broken.

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
