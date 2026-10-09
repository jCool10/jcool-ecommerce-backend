import { describe, expect, it, vi } from 'vitest';
import { PaymentParticipantFacade } from './payment-participant.facade';
import { PaymentGatewayError } from './ports/payment-gateway.port';
import { PaymentProviderUnavailableError, type OpenSessionResult } from './public/payment-participant.port';
import type { CancelPaymentUseCase } from './use-cases/cancel-payment.use-case';
import type { CapturePaymentUseCase } from './use-cases/capture-payment.use-case';
import { ConcurrentSessionOpenError, type OpenPaymentSessionUseCase } from './use-cases/open-payment-session.use-case';

const input = { orderId: '900001', amountMinor: 120_000, currency: 'VND', expiresAt: new Date('2026-03-01T10:00:00Z') };
const opened: OpenSessionResult = { outcome: 'OPENED', paymentId: '900002', providerSessionId: 'cs_test_1' };

function facadeOver(execute: OpenPaymentSessionUseCase['execute']): PaymentParticipantFacade {
  return new PaymentParticipantFacade(
    { execute } as OpenPaymentSessionUseCase,
    {} as CapturePaymentUseCase,
    {} as CancelPaymentUseCase,
  );
}

describe('PaymentParticipantFacade.openSession', () => {
  it('answers what the use case answers', async () => {
    await expect(facadeOver(vi.fn().mockResolvedValue(opened)).openSession(input)).resolves.toEqual(opened);
  });

  it('reports a gateway fault as the provider being unavailable, keeping the cause', async () => {
    const fault = new PaymentGatewayError('breaker open');

    const error: unknown = await facadeOver(vi.fn().mockRejectedValue(fault))
      .openSession(input)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PaymentProviderUnavailableError);
    expect((error as Error).cause).toBe(fault);
  });

  it('opens once more after losing a concurrent open, and no more than that', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new ConcurrentSessionOpenError(input.orderId))
      .mockResolvedValueOnce(opened);

    await expect(facadeOver(execute).openSession(input)).resolves.toEqual(opened);

    const twice = vi.fn().mockRejectedValue(new ConcurrentSessionOpenError(input.orderId));
    await expect(facadeOver(twice).openSession(input)).rejects.toBeInstanceOf(ConcurrentSessionOpenError);
    expect(twice).toHaveBeenCalledTimes(2);
  });
});
