import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@jcool/platform/mail';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { UserContactPort } from '../../application/ports/user-contact.port';
import { OrderRefundedMailHandler } from './order-refunded-mail.handler';

const ORDER_ID = '0198f0d8-1111-7000-8000-000000000001';
const USER_ID = '0198f0d8-2222-8000-8000-000000000001';
const OCCURRED_AT = '2026-11-09T00:00:00.000Z';

function job(payload: Record<string, unknown>): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000009',
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.refunded',
    payload,
    occurredAt: OCCURRED_AT,
    traceparent: null,
  };
}

const REFUNDED = {
  orderId: ORDER_ID,
  userId: USER_ID,
  totalAmountMinor: 21_000_000,
  currency: 'VND',
  requestedBy: '137465797020397182',
};

function build(overrides: { find?: UserContactPort['find']; sendMail?: () => Promise<void> } = {}) {
  const find = vi.fn<UserContactPort['find']>(overrides.find ?? (() => Promise.resolve({ email: 'buyer@test.local' })));
  const sendMail = vi.fn<(message: MailMessage) => Promise<void>>(overrides.sendMail ?? (() => Promise.resolve()));
  const metrics = fakeMetricsPort();
  const error = vi.fn();
  const handler = new OrderRefundedMailHandler({ find }, { sendMail }, metrics, fakePinoLogger({ error }));
  return { handler, find, sendMail, metrics, error };
}

describe('OrderRefundedMailHandler', () => {
  it('mails the buyer the order and the total refunded, once the effect runs', async () => {
    const { handler, find, sendMail } = build();

    const send = await handler.prepare(job(REFUNDED));
    expect(find).toHaveBeenCalledWith(USER_ID, new Date(OCCURRED_AT));
    expect(sendMail).not.toHaveBeenCalled();
    await send();

    expect(sendMail).toHaveBeenCalledOnce();
    const [message] = sendMail.mock.calls[0];
    expect(message).toMatchObject({ to: 'buyer@test.local', subject: 'Your refund has been issued' });
    expect(message.text).toContain(`Order: ${ORDER_ID}`);
    expect(message.text).toContain('Refunded: ₫21,000,000');
    // Who refunded it is for the audit trail, not for the buyer.
    expect(message.text).not.toContain(REFUNDED.requestedBy);
  });

  it('omits the total rather than guessing when the payload cannot be read', async () => {
    const { handler, sendMail } = build();

    await (
      await handler.prepare(job({ orderId: ORDER_ID, userId: USER_ID, currency: 'not-a-code' }))
    )();

    expect(sendMail.mock.calls[0][0].text).not.toContain('Refunded:');
  });

  it('refuses permanently on no ids to work from', async () => {
    const { handler, find } = build();

    await expect(handler.prepare(job({ orderId: ORDER_ID }))).rejects.toBeInstanceOf(PermanentError);
    expect(find).not.toHaveBeenCalled();
  });

  it('refuses permanently when the buyer no longer exists', async () => {
    const { handler } = build({ find: () => Promise.resolve(null) });

    await expect(handler.prepare(job(REFUNDED))).rejects.toBeInstanceOf(PermanentError);
  });

  it('throws a directory outage through, so the delivery retries on its ladder', async () => {
    const outage = new Error('user-service unavailable');
    const { handler, sendMail } = build({ find: () => Promise.reject(outage) });

    await expect(handler.prepare(job(REFUNDED))).rejects.toBe(outage);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('counts a failed send once as order_refunded and never retries it', async () => {
    const { handler, sendMail, metrics, error } = build({ sendMail: () => Promise.reject(new Error('smtp down')) });

    await expect((await handler.prepare(job(REFUNDED)))()).resolves.toBeUndefined();

    expect(sendMail).toHaveBeenCalledOnce();
    expect(metrics.recordMailSendFailure).toHaveBeenCalledExactlyOnceWith('order_refunded');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, messageId: job(REFUNDED).outboxId }),
      'refund mail was not delivered and will not be retried',
    );
  });
});
