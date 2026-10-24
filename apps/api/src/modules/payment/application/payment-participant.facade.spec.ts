import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import type { CancelPaymentUseCase } from './use-cases/cancel-payment.use-case';
import type { CapturePaymentUseCase } from './use-cases/capture-payment.use-case';
import type { OpenPaymentSessionUseCase } from './use-cases/open-payment-session.use-case';
import { fakePaymentOrderRepository } from '../testing/payment-port.doubles';
import { PaymentParticipantFacade } from './payment-participant.facade';

function setup() {
  const open = { execute: vi.fn().mockResolvedValue({ outcome: 'CLOSED' }) };
  const capture = { execute: vi.fn().mockResolvedValue('CAPTURED') };
  const cancel = { execute: vi.fn().mockResolvedValue('FENCED') };
  const findParticipantStatuses = vi.fn().mockResolvedValue(new Map());
  const metrics = fakeMetricsPort();
  const facade = new PaymentParticipantFacade(
    open as unknown as OpenPaymentSessionUseCase,
    capture as unknown as CapturePaymentUseCase,
    cancel as unknown as CancelPaymentUseCase,
    fakePaymentOrderRepository({ findParticipantStatuses }),
    metrics,
  );
  return { facade, open, capture, cancel, findParticipantStatuses, metrics };
}

describe('PaymentParticipantFacade', () => {
  it('counts each command under its own op, by outcome', async () => {
    const { facade, metrics } = setup();
    const expiresAt = new Date();

    await facade.openSession({ orderId: '7001', amountMinor: 1, currency: 'VND', expiresAt });
    await facade.capture({ orderId: '7001' });
    await facade.cancel({ orderId: '7001' });

    expect(metrics.recordTccBranch.mock.calls).toEqual([
      ['payment', 'open_session', 'closed'],
      ['payment', 'capture', 'captured'],
      ['payment', 'cancel', 'fenced'],
    ]);
  });

  it('counts a command that throws as an error and lets it through', async () => {
    const { facade, capture, metrics } = setup();
    capture.execute.mockRejectedValueOnce(new Error('stripe down'));

    await expect(facade.capture({ orderId: '7001' })).rejects.toThrow('stripe down');
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('payment', 'capture', 'error');
  });

  it('answers an empty batch without a query', async () => {
    const { facade, findParticipantStatuses } = setup();

    await expect(facade.statusOf([])).resolves.toEqual(new Map());
    expect(findParticipantStatuses).not.toHaveBeenCalled();
  });
});
