import type { ArgumentsHost } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_UNAVAILABLE, isProviderUnavailable } from '@jcool/internal-contracts';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentGatewayError } from '../../application/public/payment-participant.port';
import { ProviderUnavailableFilter } from './provider-unavailable.filter';

function httpHost() {
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { method: 'POST', path: '/internal/v1/payments/1/capture', route: { path: '/:orderId/capture' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('ProviderUnavailableFilter', () => {
  it('answers a 503 the caller reads as Stripe being away, with Retry-After and the request id, logged as a warning', () => {
    const warn = vi.fn();
    const error = vi.fn();
    const cls = { isActive: () => true, getId: () => 'req-1' } as unknown as ClsService;
    const filter = new ProviderUnavailableFilter(fakePinoLogger({ warn, error }), cls);
    const { host, response } = httpHost();

    const fault = new PaymentGatewayError('gateway could not capture: timeout');

    filter.catch(fault, host);

    const body: unknown = response.json.mock.calls[0]?.[0];
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(body).toEqual({
      statusCode: 503,
      code: PROVIDER_UNAVAILABLE,
      message: 'Service unavailable',
      requestId: 'req-1',
    });
    expect(isProviderUnavailable(503, body)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/:orderId/capture', err: fault }),
      expect.any(String),
    );
    expect(error).not.toHaveBeenCalled();
  });
});
