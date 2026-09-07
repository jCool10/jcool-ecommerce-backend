import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { buildBootSummary } from './boot-summary';

const DSN = 'https://public@o1.ingest.sentry.io/42';
const METRICS_TOKEN = 'super-secret-metrics-token';

function configStub(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'app.env': 'production',
    'app.port': 3000,
    'app.swaggerEnabled': false,
    'app.corsOrigins': ['https://a.example', 'https://b.example'],
    'app.trustProxy': 1,
    'app.cookieSecure': true,
    'app.shutdownGracePeriodMs': 5000,
    'log.level': 'info',
    'log.version': 'abc123def456',
    'tracing.enabled': false,
    'sentry.enabled': true,
    'sentry.dsn': DSN,
    'metrics.token': METRICS_TOKEN,
    'outbox.relayEnabled': true,
    'queue.workerEnabled': true,
    'auth.requireVerifiedEmail': false,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('buildBootSummary', () => {
  it('reports the feature gates that change runtime behavior', () => {
    expect(buildBootSummary(configStub())).toMatchObject({
      logLevel: 'info',
      port: 3000,
      swagger: false,
      trustProxy: true,
      cookieSecure: true,
      shutdownGraceMs: 5000,
      tracing: false,
      outboxRelay: true,
      queueWorker: true,
      requireVerifiedEmail: false,
    });
  });

  // The logger's base already stamps these on the line; repeating them makes a duplicate JSON key,
  // which parsers resolve by coin-flip.
  it('does not repeat the fields the logger base already stamps', () => {
    const summary = buildBootSummary(configStub());

    expect(summary).not.toHaveProperty('env');
    expect(summary).not.toHaveProperty('version');
    expect(summary).not.toHaveProperty('service');
  });

  // This line is the most-copied line in any log platform; a secret in it travels everywhere.
  it('reports secrets as booleans, never their values', () => {
    const summary = buildBootSummary(configStub());

    expect(summary.sentry).toBe(true);
    expect(summary.metricsGuarded).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(DSN);
    expect(JSON.stringify(summary)).not.toContain(METRICS_TOKEN);
  });

  it('reports unset secrets as false rather than omitting them', () => {
    const summary = buildBootSummary(configStub({ 'sentry.enabled': false, 'metrics.token': undefined }));

    expect(summary.sentry).toBe(false);
    expect(summary.metricsGuarded).toBe(false);
  });

  // The allow-list can be long and its contents are not the operational question; "is CORS on" is.
  it('counts CORS origins instead of listing them', () => {
    expect(buildBootSummary(configStub()).corsOrigins).toBe(2);
    expect(buildBootSummary(configStub({ 'app.corsOrigins': undefined })).corsOrigins).toBe(0);
  });

  // trustProxy is a union (false | true | hop count | subnet CSV); the line carries whether it is on.
  it('reduces trustProxy to whether it is on', () => {
    expect(buildBootSummary(configStub({ 'app.trustProxy': false })).trustProxy).toBe(false);
    expect(buildBootSummary(configStub({ 'app.trustProxy': 'loopback' })).trustProxy).toBe(true);
  });
});
