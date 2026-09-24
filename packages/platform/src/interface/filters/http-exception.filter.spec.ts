import { ArgumentsHost, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { ClockStalledError } from '@jcool/id-generator/errors';
import { DomainError } from '@jcool/kernel';
import type { ClsService } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { HttpExceptionFilter } from './http-exception.filter';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

const captureException = vi.mocked(Sentry.captureException);

const cls = { isActive: () => true, getId: () => 'req-1', get: () => undefined } as unknown as ClsService;
const config = fakeConfigService({ 'app.env': 'test' });
const logWarn = vi.fn();
const logger = fakePinoLogger({ warn: logWarn });
const rejection = (): Record<string, unknown> => logWarn.mock.calls[0][0] as Record<string, unknown>;

// `routePath: null` models an unmatched request: Express leaves `req.route` unset, which is every 404.
function makeHost(method = 'GET', url = '/debug/boom', routePath?: string | null) {
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
    baseUrl: '',
    headers: {},
    ...(routePath === null ? {} : { route: { path: routePath ?? path } }),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter(logger, cls, config);

  beforeEach(() => {
    captureException.mockClear();
    logWarn.mockClear();
  });

  describe('Sentry reporting', () => {
    it('reports a 5xx with requestId, traceId and route tags', () => {
      filter.catch(new Error('boom'), makeHost('GET', '/debug/boom').host);

      expect(captureException).toHaveBeenCalledTimes(1);
      const [reported, hint] = captureException.mock.calls[0];
      expect(reported).toBeInstanceOf(Error);
      // Asserted on the whole hint: `tags` lives on only one arm of Sentry's
      // ExclusiveEventHintOrCaptureContext union, so reading it off the union directly does not compile.
      expect(hint).toMatchObject({ tags: { request_id: 'req-1', trace_id: undefined, route: 'GET /debug/boom' } });
    });

    it('does not report a 4xx or a DomainError', () => {
      filter.catch(new BadRequestException('bad'), makeHost('POST', '/auth/register').host);
      filter.catch(new DomainError('Email is not a valid address'), makeHost('POST', '/auth/register').host);

      expect(captureException).not.toHaveBeenCalled();
    });
  });

  describe('status mapping', () => {
    it('answers 503 for a stalled identity clock, not 500', () => {
      const { host, response } = makeHost('POST', '/auth/register');

      filter.catch(new ClockStalledError('deadline'), host);

      expect(response.status).toHaveBeenCalledWith(503);
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
  });

  describe('log fields', () => {
    // Nest mounts every route on the root app with its full path, so a matched request carries the
    // template in `route.path` and an empty `baseUrl`.
    it('logs the route template, not the concrete url', () => {
      const { host, response } = makeHost('GET', '/orders/01H8XYZ?expand=items', '/orders/:orderId');

      filter.catch(new BadRequestException('bad'), host);

      expect(rejection()).toMatchObject({ route: '/orders/:orderId' });
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ path: '/orders/01H8XYZ?expand=items' }));
    });

    it('falls back to the query-free path when no route matched', () => {
      const { host } = makeHost('GET', '/nope/whatever?x=1', null);

      filter.catch(new NotFoundException(), host);

      expect(rejection()).toMatchObject({ route: '/nope/whatever' });
    });

    // A DomainError gets no Sentry event, so the warn line is the only place its stack survives.
    it('keeps the stack of a DomainError on the warn line', () => {
      const domainError = new DomainError('Email is not a valid address');

      filter.catch(domainError, makeHost('POST', '/auth/register').host);

      expect(rejection()).toMatchObject({ err: domainError });
    });

    it('logs the cause behind a rejection without sending it to the client', () => {
      const { host, response } = makeHost('GET', '/cart');
      const cause = new Error('"exp" claim timestamp check failed');

      filter.catch(new UnauthorizedException('Unauthorized', { cause }), host);

      expect(rejection()).toMatchObject({ reason: 'Unauthorized', cause: '"exp" claim timestamp check failed' });
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, message: 'Unauthorized' }));
      expect(response.json).toHaveBeenCalledWith(expect.not.objectContaining({ cause: expect.anything() as unknown }));
    });

    // An unmatched GET on a mailed `?token=` link is answered `Cannot GET <url>`, query and all.
    it('drops the query string from a reason that echoes the url', () => {
      const { host } = makeHost('GET', '/auth/verify-email?token=mailed-secret', null);

      filter.catch(new NotFoundException('Cannot GET /auth/verify-email?token=mailed-secret'), host);

      expect(rejection()).toMatchObject({ reason: 'Cannot GET /auth/verify-email' });
      expect(JSON.stringify(logWarn.mock.calls)).not.toContain('mailed-secret');
    });
  });
});
