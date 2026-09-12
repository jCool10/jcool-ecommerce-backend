import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { MailMessage } from '@shared/mail/mail-transport.port';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { Role } from '@shared/rbac';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
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

const tx = Symbol('tx') as unknown as DrizzleTx;

function build() {
  const getUserSummary = vi.fn().mockResolvedValue({ id: USER_ID, email: 'buyer@test.local', role: Role.Customer });
  const sendMail = vi.fn().mockResolvedValue(undefined);
  const recordMailSendFailure = vi.fn();
  const error = vi.fn();
  const handler = new OrderPaidMailHandler(
    { getUserSummary },
    { sendMail },
    { recordMailSendFailure } as unknown as MetricsPort,
    fakePinoLogger({ error }),
  );
  return {
    handler,
    getUserSummary,
    sendMail,
    recordMailSendFailure,
    error,
    sent: () => sendMail.mock.calls[0][0] as MailMessage,
  };
}

describe('OrderPaidMailHandler', () => {
  // The consumer already holds a pool connection for this job's transaction; a lookup off the pool
  // would take a second one and can deadlock the pool under worker concurrency.
  it('reads the address on the consumer transaction rather than off the pool', async () => {
    const ctx = build();

    await ctx.handler.prepare(job(PAID), tx);

    expect(ctx.getUserSummary).toHaveBeenCalledWith(USER_ID, tx);
  });

  it('renders the total in major units for the order currency', async () => {
    const ctx = build();
    await (
      await ctx.handler.prepare(job(PAID), tx)
    )();
    // VND has no minor unit, so the payload's minor amount is already the figure a buyer recognises.
    expect(ctx.sent().text).toContain('₫21,000,000');
  });

  it('omits the total rather than guessing when the payload cannot be read', async () => {
    const ctx = build();
    await (
      await ctx.handler.prepare(job({ orderId: ORDER_ID, userId: USER_ID, currency: 'not-a-code' }), tx)
    )();
    expect(ctx.sent().text).not.toContain('Total');
  });

  // Every redelivery carries the same bytes, so retrying could only fail the same way. Only the
  // unreadable-payload half is asserted here: no e2e ever delivers an `order.paid` without a userId,
  // while the user-is-gone half is proven end to end.
  it('refuses permanently on no ids to work from', async () => {
    const ctx = build();
    await expect(ctx.handler.prepare(job({ orderId: ORDER_ID }), tx)).rejects.toBeInstanceOf(PermanentError);
  });
});
