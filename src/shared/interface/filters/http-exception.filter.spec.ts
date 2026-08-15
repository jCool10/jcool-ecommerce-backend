import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
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

function makeHost(method = 'GET', url = '/debug/boom'): ArgumentsHost {
  const response = {
    setHeader: vi.fn(),
    getHeader: vi.fn(() => undefined),
    status: vi.fn(() => response),
    json: vi.fn(),
  };
  const request = { method, url, path: url, route: { path: url }, headers: {} };
  return {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
}

describe('HttpExceptionFilter — Sentry reporting', () => {
  const filter = new HttpExceptionFilter(logger, cls, config);

  beforeEach(() => captureException.mockClear());

  it('reports a 5xx to Sentry with requestId/traceId/route tags', () => {
    filter.catch(new Error('boom'), makeHost('GET', '/debug/boom'));

    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, options] = captureException.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect(options?.tags).toMatchObject({ request_id: 'req-1', trace_id: undefined, route: 'GET /debug/boom' });
  });

  it('does NOT report a 4xx client error (avoids Sentry noise)', () => {
    filter.catch(new BadRequestException('bad'), makeHost('POST', '/auth/register'));

    expect(captureException).not.toHaveBeenCalled();
  });
});
