import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { Counter, Gauge } from 'prom-client';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { describe, expect, it, vi } from 'vitest';
import { LoadSheddingMiddleware } from './load-shedding.middleware';

class FakeResponse extends EventEmitter {
  statusCode = 200;
  readonly headers: Record<string, string> = {};
  body: unknown;

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }

  emitClose(): void {
    this.emit('close');
  }
}

const request = (path: string, method = 'GET') => ({ path, url: path, method }) as Request;

function build(maxInFlight: number) {
  const shed = { inc: vi.fn() };
  const gauge = { inc: vi.fn(), dec: vi.fn() };
  const warn = vi.fn();
  const middleware = new LoadSheddingMiddleware(
    fakeConfigService({ 'resilience.loadShedding': { maxInFlight, retryAfterSec: 2 } }),
    shed as unknown as Counter<string>,
    gauge as unknown as Gauge<string>,
    fakePinoLogger({ warn }),
  );
  const pass = (path = '/products', method?: string) => {
    const res = new FakeResponse();
    const next = vi.fn();
    middleware.handle(request(path, method), res as unknown as Response, next);
    return { res, next };
  };
  return { pass, shed, gauge, warn };
}

describe('LoadSheddingMiddleware', () => {
  it('admits up to the limit and answers the next request 503 with Retry-After', () => {
    const { pass, shed } = build(2);
    const admitted = [pass(), pass()];
    const refused = pass('/products?page=2', 'POST');

    expect(admitted.every(({ next }) => next.mock.calls.length === 1)).toBe(true);
    expect(refused.next).not.toHaveBeenCalled();
    expect(refused.res.statusCode).toBe(503);
    expect(refused.res.headers['Retry-After']).toBe('2');
    expect(refused.res.body).toMatchObject({ statusCode: 503, path: '/products?page=2' });
    expect(shed.inc).toHaveBeenCalledWith({ method: 'POST' });
  });

  it('frees a slot when an admitted response closes, finished or aborted', () => {
    const { pass, gauge } = build(1);
    const first = pass();
    expect(pass().next).not.toHaveBeenCalled();

    first.res.emitClose();
    // A second close on the same response must not free a slot twice.
    first.res.emitClose();

    expect(pass().next).toHaveBeenCalledTimes(1);
    expect(pass().next).not.toHaveBeenCalled();
    expect(gauge.inc).toHaveBeenCalledTimes(2);
    expect(gauge.dec).toHaveBeenCalledTimes(1);
  });

  it('never sheds or counts health and metrics probes', () => {
    const { pass, gauge } = build(1);
    pass();

    for (const path of ['/health', '/health/live', '/health/ready', '/metrics']) {
      expect(pass(path).next).toHaveBeenCalledTimes(1);
    }
    expect(pass('/healthz').next).not.toHaveBeenCalled();
    expect(gauge.inc).toHaveBeenCalledTimes(1);
  });

  it('passes everything through when the limit is 0', () => {
    const { pass, shed, gauge } = build(0);
    for (let i = 0; i < 5; i += 1) {
      expect(pass().next).toHaveBeenCalledTimes(1);
    }
    expect(shed.inc).not.toHaveBeenCalled();
    expect(gauge.inc).not.toHaveBeenCalled();
  });

  it('logs a burst of refusals once, not once per request', () => {
    const { pass, warn } = build(1);
    pass();
    for (let i = 0; i < 10; i += 1) pass();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ inFlight: 1, maxInFlight: 1 }, 'shedding load');
  });
});
