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

function makeHost(method = 'GET', url = '/debug/boom') {
  const response = {
    setHeader: vi.fn(),
    getHeader: vi.fn(() => undefined),
    status: vi.fn(() => response),
    json: vi.fn(),
  };
  const request = { method, url, path: url, route: { path: url }, headers: {} };
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
