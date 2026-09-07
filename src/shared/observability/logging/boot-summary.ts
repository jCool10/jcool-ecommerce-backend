import type { ConfigService } from '@nestjs/config';

/**
 * The one line at startup that answers "why is prod behaving differently from dev" without a shell
 * on the box. Every entry is a feature gate that changes runtime behavior, so a puzzling incident
 * can be checked against what this deploy actually had switched on.
 *
 * Invariant: a secret contributes only a boolean "configured / not". Never the value — this line is
 * the most-copied line in any log platform.
 */
export function buildBootSummary(config: ConfigService): Record<string, unknown> {
  return {
    // `env` and `version` are not repeated here — the logger's base already stamps them on this
    // line, and a duplicate JSON key is a parser coin-flip.
    logLevel: config.get<string>('log.level'),
    port: config.get<number>('app.port'),
    swagger: config.get<boolean>('app.swaggerEnabled'),
    // Count, not the list: the allow-list can be long, and "is CORS on" is the operational question.
    corsOrigins: (config.get<string[]>('app.corsOrigins') ?? []).length,
    trustProxy: config.get<boolean | number | string>('app.trustProxy') !== false,
    cookieSecure: config.get<boolean>('app.cookieSecure'),
    shutdownGraceMs: config.get<number>('app.shutdownGracePeriodMs'),
    tracing: config.get<boolean>('tracing.enabled'),
    // Derived from SENTRY_DSN in configuration.ts — a boolean, never the DSN itself.
    sentry: config.get<boolean>('sentry.enabled') === true,
    // Whether GET /metrics requires a bearer token. The token itself never appears here.
    metricsGuarded: Boolean(config.get<string>('metrics.token')),
    outboxRelay: config.get<boolean>('outbox.relayEnabled'),
    queueWorker: config.get<boolean>('queue.workerEnabled'),
    requireVerifiedEmail: config.get<boolean>('auth.requireVerifiedEmail'),
  };
}
