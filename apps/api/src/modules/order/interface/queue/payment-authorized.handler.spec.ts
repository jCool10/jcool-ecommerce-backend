import { describe, expect, it, vi } from 'vitest';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import { sampleId } from '@shared/testing/id-generator.double';
import type { ForwardPaymentAuthorizationUseCase } from '../../application/use-cases';
import { PaymentAuthorizedHandler } from './payment-authorized.handler';

const ORDER_ID = sampleId(1);
const PAYLOAD = {
  paymentId: 'pay-1',
  orderId: ORDER_ID,
  amountMinor: 200_000,
  currency: 'VND',
  authorizedAt: '2026-10-20T08:10:00.000Z',
};

function job(payload: Record<string, unknown>): DomainEventJob {
  return {
    outboxId: 'outbox-1',
    aggregateType: 'Payment',
    aggregateId: 'pay-1',
    eventType: 'payment.authorized',
    payload,
    occurredAt: '2026-10-20T08:10:00.000Z',
    traceparent: null,
  };
}

function build() {
  const execute = vi.fn().mockResolvedValue(undefined);
  const handler = new PaymentAuthorizedHandler({ execute } as unknown as ForwardPaymentAuthorizationUseCase);
  return { handler, execute };
}

describe('PaymentAuthorizedHandler', () => {
  it('forwards the authorization with only the fields the saga takes', async () => {
    const { handler, execute } = build();

    await handler.forward(job({ ...PAYLOAD, extra: 'ignored' }));

    expect(execute).toHaveBeenCalledExactlyOnceWith(ORDER_ID, {
      paymentId: 'pay-1',
      amountMinor: 200_000,
      currency: 'VND',
      authorizedAt: '2026-10-20T08:10:00.000Z',
    });
  });

  // Identical on every redelivery, so a retry could only fail the same way: straight to the DLQ.
  it('dead-letters a payload it cannot read', async () => {
    const broken: Record<string, unknown>[] = [
      { ...PAYLOAD, orderId: undefined },
      // Postgres would reject it as a bigint, and the error would read as transient.
      { ...PAYLOAD, orderId: 'order-1' },
      { ...PAYLOAD, paymentId: 42 },
      { ...PAYLOAD, amountMinor: '200000' },
      { ...PAYLOAD, amountMinor: 1.5 },
      { ...PAYLOAD, currency: '' },
      { ...PAYLOAD, currency: 'vnd' },
      { ...PAYLOAD, authorizedAt: 'yesterday' },
      { ...PAYLOAD, authorizedAt: '2026-10-20T15:10:00+07:00' },
    ];

    for (const payload of broken) {
      const { handler, execute } = build();

      await expect(handler.forward(job(payload)), JSON.stringify(payload)).rejects.toBeInstanceOf(PermanentError);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('lets a forwarding fault through so the job retries', async () => {
    const { handler, execute } = build();
    const down = new Error('temporal down');
    execute.mockRejectedValueOnce(down);

    await expect(handler.forward(job(PAYLOAD))).rejects.toBe(down);
  });
});
