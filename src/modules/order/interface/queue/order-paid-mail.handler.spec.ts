import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@shared/mail/mail-transport.port';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { Role } from '@shared/rbac';
import { OrderPaidMailHandler } from './order-paid-mail.handler';

const ORDER_ID = '0198f0d8-1111-7000-8000-000000000001';
const USER_ID = '0198f0d8-2222-8000-8000-000000000001';

function job(payload: Record<string, unknown>): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.paid',
    payload,
    occurredAt: '2026-09-07T00:00:00.000Z',
    traceparent: null,
  };
}

const PAID = { orderId: ORDER_ID, userId: USER_ID, totalAmountMinor: 21_000_000, currency: 'VND' };

function build({ user = { id: USER_ID, email: 'buyer@test.local', role: Role.Customer }, sendFails = false } = {}) {
  const getUserSummary = vi.fn().mockResolvedValue(user);
  const sendMail = sendFails ? vi.fn().mockRejectedValue(new Error('smtp down')) : vi.fn().mockResolvedValue(undefined);
  const recordMailSendFailure = vi.fn();
  const error = vi.fn();
  const handler = new OrderPaidMailHandler(
    { getUserSummary },
    { sendMail },
    { recordMailSendFailure } as unknown as MetricsPort,
    { error } as unknown as PinoLogger,
  );
  return { handler, sendMail, recordMailSendFailure, error, sent: () => sendMail.mock.calls[0][0] as MailMessage };
}

describe('OrderPaidMailHandler', () => {
  it('resolves the address from the userId the event carries, and sends nothing until asked', async () => {
    const ctx = build();

    const effect = await ctx.handler.prepare(job(PAID));

    expect(ctx.sendMail).not.toHaveBeenCalled();
    await effect();
    expect(ctx.sent().to).toBe('buyer@test.local');
    expect(ctx.sent().text).toContain(ORDER_ID);
  });

  it('renders the total in major units for the order currency', async () => {
    const ctx = build();
    await (
      await ctx.handler.prepare(job(PAID))
    )();
    // VND has no minor unit, so the payload's minor amount is already the figure a buyer recognises.
    expect(ctx.sent().text).toContain('₫21,000,000');
  });

  it('omits the total rather than guessing when the payload cannot be read', async () => {
    const ctx = build();
    await (
      await ctx.handler.prepare(job({ orderId: ORDER_ID, userId: USER_ID, currency: 'not-a-code' }))
    )();
    expect(ctx.sent().text).not.toContain('Total');
  });

  // Every redelivery carries the same bytes, so retrying either could only fail the same way.
  it.each([
    ['no ids to work from', { orderId: ORDER_ID }],
    ['a user that no longer exists', PAID],
  ])('refuses permanently on %s', async (label, payload) => {
    const ctx = build(label === 'a user that no longer exists' ? { user: null as never } : {});
    await expect(ctx.handler.prepare(job(payload))).rejects.toBeInstanceOf(PermanentError);
  });

  it('counts a failed send instead of throwing — the message is applied and nothing will retry it', async () => {
    const ctx = build({ sendFails: true });

    await expect((await ctx.handler.prepare(job(PAID)))()).resolves.toBeUndefined();

    expect(ctx.recordMailSendFailure).toHaveBeenCalledWith('order_paid');
    expect(ctx.error).toHaveBeenCalled();
  });
});
