import type { ArgumentsHost } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { LOCK_BUDGET_EXHAUSTED, isLockBudgetExhausted } from '@jcool/internal-contracts';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { ReservationTimeoutError } from '../../domain/errors/reservation-timeout.error';
import { LockBudgetExhaustedFilter } from './lock-budget-exhausted.filter';

function httpHost() {
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { method: 'POST', path: '/internal/v1/reservations/1/try', route: { path: '/:orderId/try' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('LockBudgetExhaustedFilter', () => {
  it('answers a 503 the caller reads as busy rows, with Retry-After and the request id, logged as a warning', () => {
    const warn = vi.fn();
    const error = vi.fn();
    const cls = { isActive: () => true, getId: () => 'req-1' } as unknown as ClsService;
    const filter = new LockBudgetExhaustedFilter(fakePinoLogger({ warn, error }), cls);
    const { host, response } = httpHost();

    filter.catch(new ReservationTimeoutError(), host);

    const body: unknown = response.json.mock.calls[0]?.[0];
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(body).toEqual({
      statusCode: 503,
      code: LOCK_BUDGET_EXHAUSTED,
      message: 'Service unavailable',
      requestId: 'req-1',
    });
    expect(isLockBudgetExhausted(503, body)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ route: '/:orderId/try' }), expect.any(String));
    expect(error).not.toHaveBeenCalled();
  });
});
