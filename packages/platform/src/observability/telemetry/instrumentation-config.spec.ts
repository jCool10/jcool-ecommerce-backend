import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { autoInstrumentationConfig } from './instrumentation-config';

const config = autoInstrumentationConfig();
const requestTo = (url: string) => ({ url, method: 'GET', headers: {} }) as IncomingMessage;

describe('autoInstrumentationConfig', () => {
  it('keeps fs and pino off and http, express, undici, pg and ioredis on', () => {
    expect(config['@opentelemetry/instrumentation-fs']?.enabled).toBe(false);
    expect(config['@opentelemetry/instrumentation-pino']?.enabled).toBe(false);
    for (const name of [
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-express',
      '@opentelemetry/instrumentation-undici',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/instrumentation-ioredis',
    ] as const) {
      expect(config[name]?.enabled, name).toBe(true);
    }
  });

  it('traces no health probe and no metrics scrape', () => {
    const ignored = config['@opentelemetry/instrumentation-http']?.ignoreIncomingRequestHook;

    expect(
      ['/health/live', '/health/ready', '/metrics', '/metrics?name[]=x'].map((url) => ignored?.(requestTo(url))),
    ).toEqual([true, true, true, true]);
    expect(['/orders', '/orders?next=/health/live', '/metrics-export'].map((url) => ignored?.(requestTo(url)))).toEqual(
      [false, false, false],
    );
  });

  // Express 5 dispatches through the `router` package, whose own instrumentation spans every layer.
  it('makes no span for a middleware layer, through express or router', () => {
    expect(config['@opentelemetry/instrumentation-express']?.ignoreLayersType).toEqual(['middleware']);
    expect(config['@opentelemetry/instrumentation-router']?.enabled).toBe(false);
  });

  it('records a database, Redis or outgoing HTTP call only inside a trace that is already open', () => {
    expect(config['@opentelemetry/instrumentation-pg']?.requireParentSpan).toBe(true);
    expect(config['@opentelemetry/instrumentation-ioredis']?.requireParentSpan).toBe(true);
    expect(config['@opentelemetry/instrumentation-http']?.requireParentforOutgoingSpans).toBe(true);
    expect(config['@opentelemetry/instrumentation-undici']?.requireParentforSpans).toBe(true);
  });

  // Neither asks for a parent, so a pool or Redis reconnect would open a trace of its own.
  it('makes no span for a DNS lookup or a socket connect', () => {
    expect(config['@opentelemetry/instrumentation-dns']?.enabled).toBe(false);
    expect(config['@opentelemetry/instrumentation-net']?.enabled).toBe(false);
  });

  it('records a Redis command by its name alone', () => {
    const serialize = config['@opentelemetry/instrumentation-ioredis']?.dbStatementSerializer;

    expect(serialize?.('set', ['throttle:login:198.51.100.7', '1', 'PX', 60_000])).toBe('set');
  });
});
