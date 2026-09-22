import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@jcool/platform/mail';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { UserContactPort } from '../../application/ports/user-contact.port';
import { OrderPaidMailHandler } from './order-paid-mail.handler';

const ORDER_ID = '0198f0d8-1111-7000-8000-000000000001';
const USER_ID = '0198f0d8-2222-8000-8000-000000000001';
const OCCURRED_AT = '2026-09-07T00:00:00.000Z';

function job(payload: Record<string, unknown>): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.paid',
    payload,
    occurredAt: OCCURRED_AT,
    traceparent: null,
  };
}

const PAID = { orderId: ORDER_ID, userId: USER_ID, totalAmountMinor: 21_000_000, currency: 'VND' };

function build() {
  const find = vi.fn<UserContactPort['find']>().mockResolvedValue({ email: 'buyer@test.local' });
  const sendMail = vi.fn().mockResolvedValue(undefined);
  const recordMailSendFailure = vi.fn();
  const error = vi.fn();
  const handler = new OrderPaidMailHandler(
    { find },
    { sendMail },
    { recordMailSendFailure } as unknown as MetricsPort,
    fakePinoLogger({ error }),
  );
  return {
    handler,
    find,
    sendMail,
    recordMailSendFailure,
    error,
    sent: () => sendMail.mock.calls[0][0] as MailMessage,
  };
}

describe('OrderPaidMailHandler', () => {
  it('asks the directory for the buyer as of when the order was paid', async () => {
    const ctx = build();

    await ctx.handler.prepare(job(PAID));

    expect(ctx.find).toHaveBeenCalledWith(USER_ID, new Date(OCCURRED_AT));
  });

  it('addresses the confirmation to the buyer', async () => {
    const ctx = build();
    const send = await ctx.handler.prepare(job(PAID));
    await send();

    expect(ctx.sent().to).toBe('buyer@test.local');
  });

  it('renders the total in major units for the order currency', async () => {
    const ctx = build();
    const send = await ctx.handler.prepare(job(PAID));
    await send();
    // VND has no minor unit, so the payload's minor amount is already the figure a buyer recognises.
    expect(ctx.sent().text).toContain('₫21,000,000');
  });

  it('omits the total rather than guessing when the payload cannot be read', async () => {
    const ctx = build();
    const send = await ctx.handler.prepare(job({ orderId: ORDER_ID, userId: USER_ID, currency: 'not-a-code' }));
    await send();
    expect(ctx.sent().text).not.toContain('Total');
  });

  // Every redelivery carries the same bytes, so retrying could only fail the same way.
  it('refuses permanently on no ids to work from', async () => {
    const ctx = build();
    await expect(ctx.handler.prepare(job({ orderId: ORDER_ID }))).rejects.toBeInstanceOf(PermanentError);
    expect(ctx.find).not.toHaveBeenCalled();
  });

  it('refuses permanently once the directory says the buyer does not exist', async () => {
    const ctx = build();
    ctx.find.mockResolvedValue(null);

    await expect(ctx.handler.prepare(job(PAID))).rejects.toBeInstanceOf(PermanentError);
  });

  it('leaves a directory that could not answer to the retry ladder', async () => {
    const ctx = build();
    const outage = new Error('user-service did not answer in time');
    ctx.find.mockRejectedValue(outage);

    const outcome = ctx.handler.prepare(job(PAID));

    await expect(outcome).rejects.toBe(outage);
    await expect(outcome).rejects.not.toBeInstanceOf(PermanentError);
  });
});
