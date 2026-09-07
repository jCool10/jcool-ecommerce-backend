import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import { ClockStalledError } from '@shared/identity/identity.errors';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter';

// Sentry is a no-op without a DSN at runtime; here we mock it to assert the filter's reporting
// contract (which errors get captured, and with which tags) without a real client.
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

const captureException = vi.mocked(Sentry.captureException);

// Minimal collaborators: real @shared/observability helpers read this CLS mock; no active OTel span
// so getActiveTraceId() returns undefined (traceId absent, as in a no-tracing test run).
const cls = { isActive: () => true, getId: () => 'req-1', get: () => undefined } as unknown as ClsService;
const config = { get: () => 'test' } as unknown as ConfigService; // app.env !== 'development' → JSON branch
const logger = { error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;

/**
 * An Express-shaped request: `url` keeps the query string, `path` never does, and `route` is
 * present only once the router matched (pass `null` for the 404 / pre-match case). `baseUrl` is
 * the mount prefix the template is relative to.
 */
function makeHost(method = 'GET', url = '/debug/boom', route?: { path: string } | null, baseUrl = '') {
  const response = {
    setHeader: vi.fn(),
    getHeader: vi.fn(() => undefined),
    status: vi.fn(() => response),
    json: vi.fn(),
  };
  const path = url.split('?')[0];
  const request = {
    method,
    url,
    path,
    baseUrl,
    route: route === null ? undefined : (route ?? { path }),
    headers: {},
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('HttpExceptionFilter — Sentry reporting', () => {
  const filter = new HttpExceptionFilter(logger, cls, config);

  beforeEach(() => captureException.mockClear());

  it('reports a 5xx to Sentry with requestId/traceId/route tags', () => {
    filter.catch(new Error('boom'), makeHost('GET', '/debug/boom').host);

    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, hint] = captureException.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    // Asserted on the whole hint: `tags` lives on only one arm of Sentry's
    // ExclusiveEventHintOrCaptureContext union, so reading it off the union directly does not compile.
    expect(hint).toMatchObject({ tags: { request_id: 'req-1', trace_id: undefined, route: 'GET /debug/boom' } });
  });

  it('does NOT report a 4xx client error (avoids Sentry noise)', () => {
    filter.catch(new BadRequestException('bad'), makeHost('POST', '/auth/register').host);

    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('HttpExceptionFilter — status mapping', () => {
  const filter = new HttpExceptionFilter(logger, cls, config);

  it('answers 503 for a stalled identity clock, not 500', () => {
    const { host, response } = makeHost('POST', '/auth/register');

    filter.catch(new ClockStalledError('deadline'), host);

    expect(response.status).toHaveBeenCalledWith(503);
    // Retryable, so the client is told to retry rather than handed the blanket 5xx mask.
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 503, message: 'Service unavailable' }),
    );
  });

  it('still masks every other unexpected error as 500', () => {
    const { host, response } = makeHost('GET', '/debug/boom');

    filter.catch(new Error('boom'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, message: 'Internal server error' }),
    );
  });

  it('leaves the 4xx payload untouched', () => {
    const { host, response } = makeHost('POST', '/auth/register');

    filter.catch(new BadRequestException('bad'), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'bad' }));
  });
});

describe('HttpExceptionFilter — log line', () => {
  const error = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
  const warn = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
  const filter = new HttpExceptionFilter({ error, warn } as unknown as PinoLogger, cls, config);

  beforeEach(() => {
    error.mockClear();
    warn.mockClear();
  });

  /**
   * The leak this phase exists to close. `/auth/verify-email` and `/auth/reset-password` carry a
   * single-use credential on the query string, and their 4xx paths (expired, already used) are the
   * ones that actually log — so the raw url wrote a live secret into the log platform on the most
   * common failure. Asserted over the serialized call, not one field: a leak that moves to another
   * field is still a leak.
   */
  it('never writes a query string — and so never a token — into any log field', () => {
    const token = 'a-single-use-token-value';
    const { host } = makeHost('GET', `/auth/verify-email?token=${token}`, { path: '/verify-email' }, '/auth');

    filter.catch(new BadRequestException('Token expired'), host);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(token);
    expect(warn.mock.calls[0][0]).toMatchObject({ route: '/auth/verify-email' });
  });

  it('logs the route template, not the concrete path, so the field stays low-cardinality', () => {
    const { host } = makeHost('GET', '/products/abc-123', { path: '/:idOrSlug' }, '/products');

    filter.catch(new BadRequestException('bad id'), host);

    expect(warn.mock.calls[0][0]).toMatchObject({ route: '/products/:idOrSlug' });
  });

  // 404s and guard rejections fire before the router matches, so there is no template to use.
  it('falls back to the query-free pathname when the router never matched', () => {
    const { host } = makeHost('GET', '/nope?token=secret-value', null);

    filter.catch(new BadRequestException('nope'), host);

    expect(warn.mock.calls[0][0]).toMatchObject({ route: '/nope' });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('secret-value');
  });

  // Express 5 matches an unmatched request against its own wildcard route, so `req.route` is set
  // even on a 404 and reports `/{*path}` — the same string for every 404, which answers nothing.
  it('discards a catch-all template in favour of the concrete path', () => {
    const { host } = makeHost('GET', '/typo/endpoint?token=secret-value', { path: '/{*path}' });

    filter.catch(new BadRequestException('nope'), host);

    expect(warn.mock.calls[0][0]).toMatchObject({ route: '/typo/endpoint' });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('secret-value');
  });

  it('carries the error class as a flat field', () => {
    const { host } = makeHost('POST', '/auth/register');

    filter.catch(new BadRequestException('bad'), host);

    expect(warn.mock.calls[0][0]).toMatchObject({ errorName: 'BadRequestException' });
  });

  // The values worth alerting on without knowing them in advance: ECONNREFUSED when Postgres dies,
  // EOPENBREAKER when a circuit opens.
  it('carries an infra error code when the error has one', () => {
    const { host } = makeHost('GET', '/products');
    const broken = Object.assign(new Error('circuit open'), { code: 'EOPENBREAKER' });

    filter.catch(broken, host);

    expect(error.mock.calls[0][0]).toMatchObject({ errorCode: 'EOPENBREAKER', errorName: 'Error' });
  });

  it('omits errorCode entirely when the error carries none', () => {
    const { host } = makeHost('POST', '/auth/register');

    filter.catch(new BadRequestException('bad'), host);

    expect(warn.mock.calls[0][0]).not.toHaveProperty('errorCode');
  });
});
