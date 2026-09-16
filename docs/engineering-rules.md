# Engineering rules

What a change has to satisfy to be accepted here. The reasoning behind each individual gate lives next to the gate itself — `.github/workflows/ci.yml`, `.dependency-cruiser.cjs`, `eslint.config.mjs` and `vitest.config.mts` are all commented at the point of enforcement. This file records the judgment calls those files cannot state about themselves.

## Gates

Run locally what CI runs, in the order CI runs it — fastest-failing first:

```bash
npm run lint:check && npm run typecheck && npm run arch:check && npm run build
npm run test:cov    # unit tier, with the coverage floor
npm run test:e2e    # integration tier, needs Docker
```

`lint` (with `--fix`) is the local convenience; CI runs `lint:check` because a gate that mutates the tree is not reporting on it. `typecheck` is a separate gate rather than a side effect of the build: the build transpiles through SWC, which never checks types, so a green build says nothing about them. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) is the owner of the full sequence, including the Prometheus rule tests and the runtime-only audit floor.

## Fences are not obstacles

Every error-severity rule in [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs) and every file-scoped rule in [`eslint.config.mjs`](../eslint.config.mjs) encodes an invariant that is cheap to break by accident and expensive to notice later — a domain entity that has quietly acquired a tracing dependency, an id mint that has become interleavable, a log message that no aggregator can group.

When a fence blocks a change, the change is wrong far more often than the fence is. Do not widen a rule's scope, add a path exclusion, or reach for an inline disable to get a commit through. An exemption that is genuinely correct belongs in the rule's own configuration with a comment stating why it is correct; every exemption present today is written that way, and the two composition roots exempt from the shared-import rule are the model to follow.

## Tests

**Where a test goes.** A behaviour provable against objects is a unit spec beside its source (`src/**/*.spec.ts`). A behaviour that only exists once the application is wired to real Postgres, Redis, S3, Meilisearch or SMTP is an integration suite in [`test/integration/`](../test/integration). Do not mock the database to pull an integration concern down into the unit tier — that mock is precisely the thing the integration tier exists to stop trusting.

**Do not delete a unit spec under `src/**/{domain,application}/**` because an e2e suite appears to cover it.** Coverage is measured on the unit tier only and floored on exactly that glob ([`vitest.config.mts`](../vitest.config.mts)); e2e coverage contributes nothing to it. Removing an in-glob spec that looks redundant therefore lowers the numerator directly, and the measured slack against the functions floor has been as small as five functions — a single use-case spec has been enough to take it to one. Redundancy *outside* the glob costs nothing to remove.

**The floors are measured values minus two points, not round numbers.** Raising one after a genuine coverage win is welcome. Lowering one so that a change fits under it is not; it converts the gate into decoration.

## Migrations

Schema changes are generated, never typed into an existing file: edit the Drizzle schema, run `npm run db:generate`, and commit the emitted `.sql` together with its `meta/_journal.json` entry.

A migration that has been merged is immutable. Drizzle records each file's hash in the journal, so an edited file no longer matches what every database that already applied it ran. A correction is a new migration.

Production applies migrations as a release command, separately from application bootstrap; the reasoning and the failure mode that motivates it are in the README's Operations section.

## Commits and pull requests

Conventional commits (`feat`, `fix`, `refactor`, `test`, `chore`, …) with a scope when one is meaningful. Work reaches `main` through a pull request, and CI runs on the pull request as well as on `main`.

Never commit a secret. `.env*` is ignored except [`.env.example`](../.env.example), which is the committed template and the reference documentation for configuration — a change that adds an environment variable adds it there in the same commit, with the comment explaining it. The local Prometheus scrape token follows the same pattern: only its `.example` is committed.

## Before you propose relaxing something

The README's *Known limits* section records the gaps that are decisions rather than oversights, each with the consequence that was accepted. Several of them look like bugs from inside the code. Read them before writing a change that closes one, because the reason it is still open is usually stated there.
