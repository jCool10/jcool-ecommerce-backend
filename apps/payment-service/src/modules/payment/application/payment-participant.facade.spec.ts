import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import type { CancelPaymentUseCase } from './use-cases/cancel-payment.use-case';
import type { CapturePaymentUseCase } from './use-cases/capture-payment.use-case';
import type { OpenPaymentSessionUseCase } from './use-cases/open-payment-session.use-case';
import type { RefundPaymentUseCase } from './use-cases/refund-payment.use-case';
import { fakePaymentOrderRepository } from '../testing/payment-port.doubles';
import { PaymentParticipantFacade } from './payment-participant.facade';

function setup() {
  const open = { execute: vi.fn().mockResolvedValue({ outcome: 'CLOSED' }) };
  const capture = { execute: vi.fn().mockResolvedValue('CAPTURED') };
  const cancel = { execute: vi.fn().mockResolvedValue('FENCED') };
  const refund = { execute: vi.fn().mockResolvedValue({ outcome: 'REFUNDED' }) };
  const findParticipantStatuses = vi.fn().mockResolvedValue(new Map());
  const metrics = fakeMetricsPort();
  const facade = new PaymentParticipantFacade(
    open as unknown as OpenPaymentSessionUseCase,
    capture as unknown as CapturePaymentUseCase,
    cancel as unknown as CancelPaymentUseCase,
    refund as unknown as RefundPaymentUseCase,
    fakePaymentOrderRepository({ findParticipantStatuses }),
    metrics,
  );
  return { facade, open, capture, cancel, refund, findParticipantStatuses, metrics };
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

  it('hands a refund the actor and counts it by outcome, the reason left to the caller', async () => {
    const { facade, refund, metrics } = setup();
    const answers = [
      { outcome: 'REFUNDED' },
      { outcome: 'IDEMPOTENT' },
      { outcome: 'PENDING' },
      { outcome: 'REFUND_FAILED', reason: 'charge_disputed' },
      { outcome: 'NOT_REFUNDABLE' },
    ];
    for (const answer of answers) refund.execute.mockResolvedValueOnce(answer);

    const results = [];
    for (const _ of answers) results.push(await facade.refund({ orderId: '7001', requestedBy: '9001' }));

    expect(results).toEqual(answers);
    expect(refund.execute).toHaveBeenCalledWith('7001', '9001');
    expect(metrics.recordTccBranch.mock.calls.map(([, op, outcome]) => [op, outcome])).toEqual([
      ['refund', 'refunded'],
      ['refund', 'idempotent'],
      ['refund', 'refund_pending'],
      ['refund', 'refund_failed'],
      ['refund', 'not_refundable'],
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
