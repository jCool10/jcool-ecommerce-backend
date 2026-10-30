import { EXCEPTION_FILTERS_METADATA, FILTER_CATCH_EXCEPTIONS } from '@nestjs/common/constants';
import type { ArgumentsHost } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { CheckoutReadUnavailableError, CheckoutUnavailableError } from '../application/checkout-unavailable.error';
import { AdminOrderController } from './admin-order.controller';
import { CheckoutUnavailableFilter } from './checkout-unavailable.filter';
import { OrderController } from './order.controller';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

const cls = { isActive: () => true, getId: () => 'req-1', get: () => undefined } as unknown as ClsService;

function makeHost() {
  const headers = new Map<string, unknown>();
  const response = {
    setHeader: vi.fn((name: string, value: unknown) => headers.set(name.toLowerCase(), value)),
    getHeader: vi.fn((name: string) => headers.get(name.toLowerCase())),
    status: vi.fn(() => response),
    json: vi.fn(),
  };
  const request = { method: 'POST', url: '/orders', path: '/orders', route: { path: '/orders' }, headers: {} };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response, headers };
}

describe('CheckoutUnavailableFilter', () => {
  const logger = { error: vi.fn() };
  const filter = new CheckoutUnavailableFilter(
    fakePinoLogger(logger),
    cls,
    fakeConfigService({ 'app.env': 'test', checkoutSaga: { retryAfterSec: 5 } }),
  );

  it('answers 503 with Retry-After and the standard error body', () => {
    const { host, response, headers } = makeHost();

    filter.catch(new CheckoutUnavailableError('order-1', 'try TIMEOUT'), host);

    expect(headers.get('retry-after')).toBe('5');
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({
      statusCode: 503,
      path: '/orders',
      timestamp: expect.any(String) as unknown,
      requestId: 'req-1',
      message: 'Service unavailable',
    });
  });

  it('keeps why on the log line, never in the body', () => {
    const { host, response } = makeHost();

    filter.catch(new CheckoutUnavailableError('order-1', 'engine unavailable'), host);

    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(/order-1|engine/);
    const [[fields]] = logger.error.mock.calls as unknown as [[{ err: Error }]];
    expect((fields.err.cause as Error).message).toContain('engine unavailable');
  });

  it('answers the same 503 when the cart or the catalog could not be read', () => {
    const { host, response, headers } = makeHost();

    filter.catch(new CheckoutReadUnavailableError('api-internal answered 404'), host);

    expect(headers.get('retry-after')).toBe('5');
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('catches only the checkout errors, so every other fault keeps the global mapping', () => {
    expect(Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, CheckoutUnavailableFilter)).toEqual([
      CheckoutUnavailableError,
      CheckoutReadUnavailableError,
    ]);
  });

  // On the controller, so it runs after the idempotency interceptor has dropped the IN_PROGRESS key.
  it('is bound on both order controllers', () => {
    for (const controller of [OrderController, AdminOrderController]) {
      expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, controller), controller.name).toContain(
        CheckoutUnavailableFilter,
      );
    }
  });

  it('refuses to boot without a Retry-After', () => {
    expect(
      () => new CheckoutUnavailableFilter(fakePinoLogger(logger), cls, fakeConfigService({ 'app.env': 'test' })),
    ).toThrow(/checkoutSaga/);
  });
});
