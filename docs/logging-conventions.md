# Logging conventions

One logger, one call shape. Everything here is enforced by `eslint.config.mjs` in `apps/api/` and `packages/platform/` — the rules are named at the end of each section so a failing build points back to the reasoning. Paths are relative to `apps/api/`.

## The call shape

```ts
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';

const LOG_CONTEXT = 'FinalizeOrder';

@Injectable()
export class FinalizeOrderUseCase {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string): Promise<void> {
    try {
      await this.settle(orderId);
    } catch (caught) {
      this.logger.warn({ orderId, err: toError(caught) }, 'order settlement failed');
    }
  }
}
```

Three rules, in order of how often they are broken:

1. **The message is a static string.** It is the group key: an aggregator counts occurrences of `'order settlement failed'` and shows you the spike. Interpolate an id or an error message into it and every occurrence is its own unique string — the spike disappears into a thousand singletons, and no alert can be written against it.
2. **Values go in the fields object**, the *first* argument. `{ orderId }` is queryable (`orderId:"abc"`); `` `order ${orderId} failed` `` is a substring search that also matches the order id appearing in an unrelated message.
3. **A caught error goes in `err`**, normalized through `toError`. pino applies `stdSerializers.err` to that exact key, so the type, message and stack land as separate fields. `${error.message}` throws the stack away — the one thing you actually wanted at 3am.

`toError` lives in `@jcool/kernel`, not beside the logger: application-layer use cases log too, and the `app-domain-telemetry-free` architecture rule keeps them out of `@jcool/platform/observability`.

Enforced by `no-restricted-syntax` (template literal passed to `this.logger.*`).

## Context

`setContext(LOG_CONTEXT)` in the constructor, once. Never `{ context: LOG_CONTEXT }` per call.

`PinoLogger` is declared `@Injectable({ scope: Scope.TRANSIENT })` upstream, so **each injection site gets its own instance** — labelling it in the constructor cannot leak into another class. (The codebase previously believed it was a shared singleton and hand-stamped `context` on ~95 call sites; it is not.)

`LOG_CONTEXT` is a module-level constant, not `ClassName.name`: minifiers rename classes, and the name is often deliberately shorter than the class (`'SwrCache'`, `'RateLimit'`, `'FinalizeOrder'`).

Enforced by `no-restricted-syntax` (`context` property in a `this.logger.*` call).

### The one exception

A **free function** that receives a logger as a parameter has no constructor to label, so it passes `context` per call:

```ts
export function createQueueConnection(url: string, logger: PinoLogger): Redis {
  connection.on('error', (error: Error) => {
    logger.error({ context: LOG_CONTEXT, err: toError(error) }, 'queue redis connection error');
  });
}
```

The lint rule matches `this.logger.*` only, so `logger.*` in a free function is deliberately not fenced. Current instances: `src/shared/messaging/queue/queue-connection.ts`, `src/shared/auth/auth-verifier-options.factory.ts` (the JWKS key getter jose calls per token), `src/shared/messaging/outbox/outbox-backlog.collector.ts`, `src/modules/media/infrastructure/media-sweeping.collector.ts` — the last two are prom-client `collect` hooks, which are plain closures registered on a gauge.

## Levels

| Level | Means | Example |
| --- | --- | --- |
| `error` | A human must act. Something is lost, stuck, or owed. | refund owed; dead-letter write failed; boot check disagreed |
| `warn` | Degraded but self-correcting, or a client did something wrong. | cache rebuild failed (stale served); rate limit exceeded; tick skipped |
| `info` | A state change an operator would want in the timeline. | worker started; sweep completed *having done work*; canonical request line |
| `debug` | Diagnostic, off in production. | a revoked token replayed after logout |

Two conventions that keep the volume honest:

- **Idle work logs nothing.** A sweep that deleted 0 rows, a relay tick that moved 0 events — the steady state is silence, so a line means something happened. Every scheduler, shared or per-context, returns early on an idle result.
- **One line per failure, not one per observer.** The outbox backlog collector reports a failed read once even though two gauges await it; the dead-letter router logs the routing failure, not each retry.

## Where a line belongs

The test for a missing line: start from what a bug report hands you — an `x-request-id`, a user, an order — and follow the logs. Wherever the trail stops (no id to pivot on, no reason, an error that vanished), a line is missing. They cluster in six places:

1. **Where an error is swallowed or converted.** A `catch` that returns a fallback or moves on leaves no other trace, so it logs. A `catch` that throws a different error keeps the original as `{ cause }` instead of logging.
2. **At the boundary with another system** — Postgres, Redis, BullMQ, the payment gateway, object storage, the search engine, SMTP, the user-service and id-service: a failure, a timeout, a retry budget running out.
3. **On a business state change**, at `info`: the timeline someone rebuilds for one order, payment, asset or account.
4. **In background work** — schedulers, consumers, the outbox relay. There is no request line to lean on, so each logs a pass that did work, and every failure.
5. **On an unusual branch**: a fallback or degraded mode taken, a data mismatch, a branch the comments call unreachable.
6. **Around the process lifecycle**: boot, each shutdown stage, a crash.

A line carries what the next step of the investigation needs: the ids that find the row (`orderId`, `skuId`, `paymentId`, `messageId`, `assetId`), the caught error as `err`, and the inputs of the decision it records (status from/to, `outcome`, `reason`, `attempt`). Correlation fields come from the mixin, never by hand.

It does not belong in `domain/` (log at the caller), on function entry and exit, per item inside a hot loop, or beside an error that propagates to a layer that already logs it — `HttpExceptionFilter` for a request, the worker's failure path for a job. There, enrich the error with a `cause` instead. A 4xx message is client contract, so it is not rewritten to carry an id; the route already does.

## Who writes the request line

`autoLogging` is **off** in `logger-params.ts`. A request produces exactly one summary line:

- success → `CanonicalLogInterceptor` (`'request completed'`)
- failure → `HttpExceptionFilter` (`'request failed'` at 5xx, `'request rejected'` below it)

A `'request rejected'` line carries `reason` — the message the client was given, e.g. the validation errors, with the request's query string cut out (Nest's unmatched-route 404 echoes the url, and mailed links carry `?token=`) — and, when the exception has one, `cause`: the message of the `HttpException`'s `cause`, which is logged but never sent. That is how a guard keeps a bare `401` on the wire and still says which check refused it: `AccessTokenVerifier` puts `"exp" claim timestamp check failed`, `token epoch is behind the session epoch` and the like there. To explain a 4xx, throw it with `{ cause }` rather than logging beside it.

Health and metrics probes are skipped entirely. In development both render a single human-readable line through `formatDevRequestLine` instead of JSON.

## What is on every line for free

The pino `mixin` in `logger-params.ts` adds, when present: `requestId` (from `nestjs-cls`, echoed as the `x-request-id` response header), `job` (set by `runInJobContext`, so its presence answers "request or timer?"), `userId` (read off the request `JwtAuthGuard` authenticated, so only lines written after the guard carry it), `traceId` and `spanId` (from the active OTel span). Never re-add these by hand.

## Crashes

Each `main.ts` calls `logProcessCrashes`, which listens on `uncaughtExceptionMonitor`: the process still dies exactly as Node would kill it, but the reason is written first as one `fatal` line (`'process crashing on an uncaught error'`, with `err` and `origin`). Without Sentry an unhandled rejection becomes an uncaught exception and is logged the same way; with Sentry, its integration keeps the process alive and reports the rejection itself.

## Where the lines go

stdout, always. With `LOKI_URL` set (Railway sets it for every Node service), `logger-params.ts` also sends each line to Loki through a pino worker, labelled `service`, `env`, `level` (as `debug`, `info`, `warning`, `error`, `critical`) and `hostname`. Everything else, `requestId` included, stays a field in the line, because each distinct label value creates its own Loki stream. Operating it: `RUNBOOK.md` → *Logs in Loki*.

`redactPaths` censors credentials and tokens. Email is deliberately *not* redacted — the auth audit trail exists to record it, and the Sentry sink strips it separately.

## `console` and `Logger`

`console.*` and `Logger` from `@nestjs/common` are banned across the source tree (`src/**/*.ts` in `eslint.config.mjs`).

Exceptions, all of them processes that run outside Nest DI where there is no logger to inject:

- `src/main.ts` — exempt from the `Logger` import ban only, since the bootstrap logger runs before the pino provider exists
- `src/shared/infrastructure/database/migrate.ts`, `migrate-cli.ts` and `seed.ts`, `src/shared/infrastructure/storage/verify-storage-orphans.cli.ts`, `src/shared/messaging/queue/replay-dlq.cli.ts` and `src/modules/catalog/infrastructure/search/reindex.ts` — exempt from `no-console`: operator-facing terminal output, not application logs

Enforced by `no-restricted-imports` (the `Logger` ban) and `no-console` (also off in every `*.spec.ts`).

## Testing

Use `fakePinoLogger()` from `@jcool/testing/fake-pino-logger`, never a partial `{ warn: vi.fn() } as unknown as PinoLogger`: a partial stub answers `undefined` for the level the code actually picked, and the cast is what hides it. It also has no `setContext`, which throws in every constructor.

Assert a log line only when the line is the behaviour: an audit record, a level or count that changes on a state transition (down once, recovered once), or the only observable output of a failure path. Otherwise assert the outcome (returned value, stored state, metric) and leave the log alone; pinning every message string makes a rename a test failure without catching a bug.

When a log is the behaviour, assert its **fields structurally** and its level, and pin the message only if something outside the code keys on it (an alert, a saved query):

```ts
const warn = vi.fn();
const useCase = new SweepUseCase(repo, fakePinoLogger({ warn }));
// …
expect(warn).toHaveBeenCalledExactlyOnceWith(
  { orderId, err: expect.objectContaining({ message: 'deadlock detected' }) as unknown },
  expect.any(String),
);
```

Assert on the spies you passed in, not on `logger.warn`: `PinoLogger` declares its levels as methods, so `expect(logger.warn)` is an unbound method reference the lint rules reject.
