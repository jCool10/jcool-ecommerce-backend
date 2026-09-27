# Code standards

What a change has to satisfy to be accepted here, and the judgment calls behind each gate that the gate's own file cannot state about itself. Every rule below is enforced somewhere executable — a workflow, a lint config, a dependency graph, a schema — and that file is the source of truth for its exact shape; this page only records why it exists and where to find it.

## Gates

Run locally what CI runs, in the order CI runs it — [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) owns the sequence and comments each step with why it sits there.

Every error-severity rule in a project's `.dependency-cruiser.cjs` and every file-scoped rule in its `eslint.config.mjs` encodes an invariant that is cheap to break by accident and expensive to notice later; each rule's own comment names which one. When a fence blocks a change, the change is wrong far more often than the fence is. Do not widen a rule's scope, add a path exclusion, or reach for an inline disable to get a commit through — a genuinely correct exemption belongs in the rule's own configuration, with a comment stating why, on the model of the composition-root exemption already in [`../apps/api/.dependency-cruiser.cjs`](../apps/api/.dependency-cruiser.cjs) (`shared-no-module-internals`).

Before proposing a change that relaxes a gate, or that "fixes" something that looks like a bug, read [Known limits](../README.md#known-limits) first — several of those gaps are accepted trade-offs, not oversights, and the reason one is still open is usually stated there.

## Tests

A behavior provable against plain objects is a unit spec beside its source (`src/**/*.spec.ts`). A behavior that only exists once the app is wired to real Postgres, Redis, S3, Elasticsearch or SMTP is an integration suite in that app's `test/integration/`. Do not mock the database to pull an integration concern down into the unit tier — that mock is precisely the thing the integration tier exists to stop trusting. Tiers, what each covers, and how to run them: [`../README.md#testing`](../README.md#testing).

Coverage is measured on the unit tier only, and the floor is scoped to a glob, not global: `apps/api` and `apps/user-service` floor only their `domain`/`application` glob, because repositories, adapters and controllers are left to the e2e tier; `apps/id-service` and the packages floor the whole project. Current numbers and globs live in each project's `vitest.config.mts`, not here. A floor is the measured value minus two points — raising one after a genuine coverage win is welcome, lowering one so a change fits under it is not. Because e2e coverage never counts toward the floor, deleting a spec inside the glob lowers the measured value directly, even when an e2e suite appears to cover the same behavior; the same deletion outside the glob costs nothing.

Use `fakePinoLogger()` from `@jcool/testing/fake-pino-logger` in any spec that touches a `PinoLogger`, never a partial stub — its own docstring explains why a partial hides the exact bug a spec is meant to catch. Assert a log line only when the line is the behavior itself: an audit record, a count or level that changes on a state transition, or the only observable output of a failure path. Otherwise assert the outcome and leave the log alone. When a line is the behavior, assert its fields structurally and its level, and pin the exact message only when something outside the code keys on it.

## API conventions

The route contract — status-code semantics, the error envelope, auth per route, and every resource's endpoints — is owned by [`../README.md#api`](../README.md#api); nothing here repeats it.

One decision the README does not place: `Idempotency-Key` support is not a platform-wide interceptor. The reusable pieces — the canonical request-fingerprint hash and the CLS carrier that lets a transaction flip the stored record in the same unit of work as the write it guards — live in [`../apps/api/src/shared/idempotency`](../apps/api/src/shared/idempotency/index.ts), but the guard, interceptor and store that enforce it are implemented once, for Order's checkout ([`require-idempotency-key.guard.ts`](../apps/api/src/modules/order/interface/require-idempotency-key.guard.ts)), its only consumer today. A new route that needs the same guarantee reuses the shared utility rather than copying Order's.

## Migrations

Schema changes are generated, never typed into an existing file: edit the Drizzle schema, run the project's `db:generate`, and commit the emitted `.sql` together with its `meta/_journal.json` entry. This applies per service — `apps/api`, `apps/user-service` and `apps/id-service` each own a schema, a `drizzle.config.ts` and a migrations journal.

A migration that has been merged is immutable. Drizzle records each file's hash in the journal, so an edited file no longer matches what every database that already applied it ran — a correction is a new migration, never an edit.

Production applies migrations as a release command, separate from application bootstrap; the reasoning and the failure mode it avoids are in [`../README.md#operations`](../README.md#operations).

## Logging

One logger, one call shape, everywhere a `PinoLogger` is injected: `apps/api`, `apps/user-service`, `apps/id-service` and `packages/platform` all enforce the same rules through their own `eslint.config.mjs`. The framework-free packages (`kernel`, `id-codec`, `id-generator`, `auth-verifier`, `testing`) never inject one, so the rules don't apply there.

```ts
this.logger.setContext(LOG_CONTEXT); // once, in the constructor
this.logger.warn({ orderId, err: toError(caught) }, 'order settlement failed');
```

Three rules, in the order an author tends to break them:

1. The message is a static string — the group key an aggregator counts occurrences of. Interpolate a value into it and every occurrence becomes its own unique string; the spike an alert would key on disappears.
2. A value goes in the fields object, not the message — `{ orderId }` is queryable, `` `order ${orderId} failed` `` is a substring search.
3. A caught error goes in `err`, normalized through [`toError`](../packages/kernel/src/to-error.ts) — never `${error.message}`, which throws the stack away.

Enforced by `no-restricted-syntax` in each project's `eslint.config.mjs`.

`setContext(LOG_CONTEXT)` runs once, in the constructor, because `PinoLogger` is `Scope.TRANSIENT` — one instance per injection site — so labelling it there cannot leak into another class. `LOG_CONTEXT` is a module-level constant, not `ClassName.name`, because a minifier renames classes and the label is often deliberately shorter than one.

A free function that receives a logger as a parameter has no constructor to label, so it passes `context` per call instead. The lint selector matches a `logger` reached off some object (`this.logger.*`, `x.logger.*`) and deliberately not a bare `logger` identifier, so a free function's call is unfenced by construction. Current instances are whatever today's source has — discover them instead of trusting a list:

```
git grep -nE '(^|[^.[:alnum:]_])logger\.(warn|error|info|debug|fatal|trace)\(' -- 'apps/*/src/**' 'packages/platform/src/**'
```

### Levels

| Level | Means |
| --- | --- |
| `error` | A human must act — something is lost, stuck, or owed |
| `warn` | Degraded but self-correcting, or a client did something wrong |
| `info` | A state change an operator would want in the timeline |
| `debug` | Diagnostic, off in production |

Idle work logs nothing: a sweep that touched zero rows is silence, so a line always means something happened. One line per failure, not one per observer.

### Where a line belongs

Start from what a bug report hands you — a request id, a user, an order — and follow the logs; wherever the trail stops is a missing line. They cluster where an error is swallowed or converted, at a boundary with another system, on a business state change (`info`), in background work with no request line to lean on, on an unusual branch, and around the process lifecycle. It does not belong in `domain/` (log at the caller), or beside an error that already propagates to a layer that logs it — [`HttpExceptionFilter`](../packages/platform/src/interface/filters/http-exception.filter.ts) for a request, a worker's failure path for a job — enrich the error with `{ cause }` there instead. A 4xx message is client contract and is never rewritten to carry an id.

### Who writes the request line

`autoLogging` is off ([`logger-params.ts`](../packages/platform/src/observability/logging/logger-params.ts)), so a request produces exactly one summary line: success through [`CanonicalLogInterceptor`](../packages/platform/src/observability/logging/canonical-log.interceptor.ts), failure through `HttpExceptionFilter`. Health and metrics probes are skipped entirely. Every line also carries `requestId`, `job`, `userId`, `traceId` and `spanId` for free, through the pino mixin in the same file — never re-add these by hand.

### Crashes

Each `main.ts` calls [`logProcessCrashes`](../packages/platform/src/observability/logging/process-crash-logger.ts) so a crash's reason is logged before the process dies, exactly as Node would kill it regardless. Without Sentry, an unhandled rejection becomes an uncaught exception and is logged the same way; with Sentry installed, its own integration keeps the process alive and reports the rejection itself instead.

### Where the lines go

Always stdout. With `LOKI_URL` set, `logger-params.ts` also pushes every line to Loki through a pino worker, so a slow or dead Loki never blocks a request. Labels are kept few and bounded (the `labels` block in the same file); everything else, `requestId` included, stays a field rather than a label, because each distinct label value opens its own Loki stream. Operating it: [`../RUNBOOK.md#logs-in-loki`](../RUNBOOK.md#logs-in-loki).

### `console` and `Logger`

`console.*` and `@nestjs/common`'s `Logger` are banned in application source. The exemptions are CLI scripts that run outside Nest DI, where there is no logger to inject — each app's `eslint.config.mjs` states its own current list under its `no-console` rule.

## Commits and pull requests

Conventional commits (`feat`, `fix`, `refactor`, `test`, …) with a scope when one is meaningful. Work reaches `main` through a pull request; CI runs on the pull request and again on `main`.

Never commit a secret. `.env*` is ignored except `.env.example` — the root [`.env.example`](../.env.example) for the api and [`apps/user-service/.env.example`](../apps/user-service/.env.example) for the user-service are the committed templates and the reference for every configuration key. A new environment variable is added to its service's template, with a comment explaining it, in the same commit. The local Prometheus scrape token follows the same pattern: only its `.example` is committed.
