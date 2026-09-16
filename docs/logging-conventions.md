# Logging conventions

One logger, one call shape. Everything here is enforced by `eslint.config.mjs` — the rules are named at the end of each section so a failing build points back to the reasoning.

## The call shape

```ts
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@shared/kernel/to-error';

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

`toError` lives in `@shared/kernel/to-error`, not beside the logger: application-layer use cases log too, and the `app-domain-telemetry-free` architecture rule keeps them out of `@shared/observability`.

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

The lint rule matches `this.logger.*` only, so `logger.*` in a free function is deliberately not fenced. Current instances: `src/shared/messaging/queue/queue-connection.ts`, `src/shared/observability/metrics/outbox-backlog.collector.ts`, `src/modules/media/infrastructure/media-sweeping.collector.ts` — the last two are prom-client `collect` hooks, which are plain closures registered on a gauge.

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

## Who writes the request line

`autoLogging` is **off** in `logger.module.ts`. A request produces exactly one summary line:

- success → `CanonicalLogInterceptor` (`'request completed'`)
- failure → `HttpExceptionFilter` (`'request failed'` at 5xx, `'request rejected'` below it)

Health and metrics probes are skipped entirely. In development both render a single human-readable line through `formatDevRequestLine` instead of JSON.

## What is on every line for free

The pino `mixin` in `logger.module.ts` adds, when present: `requestId` (from `nestjs-cls`, echoed as the `x-request-id` response header), `job` (set by `runInJobContext`, so its presence answers "request or timer?"), `traceId` and `spanId` (from the active OTel span). Never re-add these by hand.

`redactPaths` censors credentials and tokens. Email is deliberately *not* redacted — the auth audit trail exists to record it, and the Sentry sink strips it separately.

## `console` and `Logger`

`console.*` and `Logger` from `@nestjs/common` are banned across the source tree (`src/**/*.ts` in `eslint.config.mjs`).

Exceptions, all of them processes that run outside Nest DI where there is no logger to inject:

- `src/main.ts` — exempt from the `Logger` import ban only, since the bootstrap logger runs before the pino provider exists
- `src/shared/infrastructure/database/migrate.ts`, `migrate-cli.ts` and `seed.ts`, `src/shared/infrastructure/storage/verify-storage-orphans.cli.ts`, `src/shared/messaging/queue/replay-dlq.cli.ts` and `src/modules/catalog/infrastructure/search/reindex.ts` — exempt from `no-console`: operator-facing terminal output, not application logs

Enforced by `no-restricted-imports` (the `Logger` ban) and `no-console` (also off in every `*.spec.ts`).

## Testing

Use `fakePinoLogger()` from `@shared/testing/fake-pino-logger`, never a partial `{ warn: vi.fn() } as unknown as PinoLogger`: a partial stub answers `undefined` for the level the code actually picked, and the cast is what hides it — the spec then passes while nothing was logged. It also has no `setContext`, which now throws in every constructor.

```ts
const warn = vi.fn();
const useCase = new SweepUseCase(repo, fakePinoLogger({ warn }));
// …
expect(warn).toHaveBeenCalledWith(
  { orderId, err: expect.objectContaining({ message: 'deadlock detected' }) as unknown },
  'expiry sweep failed for order',
);
```

Assert on the spies you passed in, not on `logger.warn` — `PinoLogger` declares its levels as methods, so `expect(logger.warn)` is an unbound method reference the lint rules reject.

Assert the **static message exactly** and the **fields structurally**. `expect.stringContaining('deadlock')` against the message was how the old interpolated style was tested; it no longer proves anything, because the value it was matching has moved into `err`.
