import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@jcool/platform/mail';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
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
  const handler = new OrderPaidMailHandler({ find }, { sendMail }, fakeMetricsPort(), fakePinoLogger());
  return { handler, find, sendMail };
}

async function sentText(payload: Record<string, unknown>): Promise<string> {
  const { handler, sendMail } = build();
  const send = await handler.prepare(job(payload));
  await send();
  return (sendMail.mock.calls[0][0] as MailMessage).text;
}

describe('OrderPaidMailHandler', () => {
  it('asks the directory for the buyer as of when the order was paid', async () => {
    const { handler, find } = build();

    await handler.prepare(job(PAID));

    expect(find).toHaveBeenCalledWith(USER_ID, new Date(OCCURRED_AT));
  });

  it('renders the total in major units for the order currency', async () => {
    const texts = await Promise.all([sentText(PAID), sentText({ ...PAID, totalAmountMinor: 1999, currency: 'USD' })]);

    expect(texts.map((text) => text.split('\n').find((row) => row.startsWith('Total')))).toEqual([
      'Total: ₫21,000,000',
      'Total: $19.99',
    ]);
  });

  it('omits the total rather than guessing when the payload cannot be read', async () => {
    const text = await sentText({ orderId: ORDER_ID, userId: USER_ID, currency: 'not-a-code' });

    expect(text).not.toContain('Total');
  });

  // Every redelivery carries the same bytes, so retrying could only fail the same way.
  it('refuses permanently on no ids to work from', async () => {
    const { handler, find } = build();

    await expect(handler.prepare(job({ orderId: ORDER_ID }))).rejects.toBeInstanceOf(PermanentError);
    expect(find).not.toHaveBeenCalled();
  });
});
