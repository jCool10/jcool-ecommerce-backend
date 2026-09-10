import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import { ClockStalledError } from '@shared/identity/identity.errors';
import { DomainError } from '@shared/kernel/domain-error';
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
const logWarn = vi.fn();
const logger = { error: vi.fn(), warn: logWarn } as unknown as PinoLogger;

// `routePath`/`baseUrl` let a test drive the concrete url and the matched template apart, which is
// the divergence the route log field has to resolve in favour of the template. `routePath: null`
// models an unmatched request — Express leaves `req.route` unset, which is every 404.
function makeHost(method = 'GET', url = '/debug/boom', routePath?: string | null, baseUrl = '') {
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
    headers: {},
    ...(routePath === null ? {} : { route: { path: routePath ?? path } }),
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

  it('does NOT report a DomainError — a broken business rule is a client error, not a handler bug', () => {
    filter.catch(new DomainError('Email is not a valid address'), makeHost('POST', '/auth/register').host);

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

  it('answers 422 for a DomainError and keeps its rule message', () => {
    const { host, response } = makeHost('POST', '/auth/register');

    filter.catch(new DomainError('Email is not a valid address'), host);

    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422, message: 'Email is not a valid address' }),
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

describe('HttpExceptionFilter — log fields', () => {
  const filter = new HttpExceptionFilter(logger, cls, config);

  beforeEach(() => logWarn.mockClear());

  // Nest registers every route on the root Express app with its fully-composed path, so a matched
  // request carries `route.path = '/orders/:orderId'` and an empty `baseUrl` — not a per-controller
  // sub-router. Driving it any other way would assert a request shape Express never builds.
  it('logs the route template, so error buckets join the success line and no query string is logged', () => {
    const { host, response } = makeHost('GET', '/orders/01H8XYZ?expand=items', '/orders/:orderId');

    filter.catch(new BadRequestException('bad'), host);

    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ route: '/orders/:orderId' }), 'request rejected');
    // The envelope still echoes the concrete url the client asked for.
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ path: '/orders/01H8XYZ?expand=items' }));
  });

  // The branch every unmatched-route 404 takes, and the filter's most-logged path.
  it('falls back to the query-free path when no route matched, rather than the raw url', () => {
    const { host } = makeHost('GET', '/nope/whatever?x=1', null);

    filter.catch(new NotFoundException(), host);

    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ route: '/nope/whatever' }), 'request rejected');
  });

  it('keeps the stack of a DomainError on the warn line, since it gets no Sentry event', () => {
    const domainError = new DomainError('Email is not a valid address');
    const { host } = makeHost('POST', '/auth/register');

    filter.catch(domainError, host);

    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ err: domainError }), 'request rejected');
  });
});
