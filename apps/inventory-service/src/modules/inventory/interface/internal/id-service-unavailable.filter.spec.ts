import type { ArgumentsHost } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { ID_SERVICE_UNAVAILABLE, isLockBudgetExhausted } from '@jcool/internal-contracts';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { IdMintUnavailableError } from '../../domain/errors/id-mint-unavailable.error';
import { IdServiceUnavailableFilter } from './id-service-unavailable.filter';

function httpHost() {
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { method: 'POST', path: '/internal/v1/reservations/1/try', route: { path: '/:orderId/try' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('IdServiceUnavailableFilter', () => {
  it('answers a 503 with its own code, never the busy-rows one, and logs the cause as an error', () => {
    const error = vi.fn();
    const cls = { isActive: () => true, getId: () => 'req-1' } as unknown as ClsService;
    const filter = new IdServiceUnavailableFilter(fakePinoLogger({ error }), cls);
    const { host, response } = httpHost();
    const cause = new Error('id service answered 503');

    filter.catch(new IdMintUnavailableError({ cause }), host);

    const body: unknown = response.json.mock.calls[0]?.[0];
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(body).toEqual({
      statusCode: 503,
      code: ID_SERVICE_UNAVAILABLE,
      message: 'Service unavailable',
      requestId: 'req-1',
    });
    expect(isLockBudgetExhausted(503, body)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: cause }), expect.any(String));
  });
});
