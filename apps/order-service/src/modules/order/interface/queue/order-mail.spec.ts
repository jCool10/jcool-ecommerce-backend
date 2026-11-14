import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@jcool/platform/mail';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { UserContactPort } from '../../application/ports/user-contact.port';
import { formatTotal, recipientOf, sendOnceAfterCommit } from './order-mail';

const ORDER_ID = '0198f0d8-1111-7000-8000-000000000001';
const USER_ID = '0198f0d8-2222-8000-8000-000000000001';
const OCCURRED_AT = '2026-09-07T00:00:00.000Z';
const MESSAGE: MailMessage = { to: 'buyer@test.local', subject: 'Subject', text: 'Body' };

const job = (payload: Record<string, unknown>): DomainEventJob => ({
  outboxId: '0198f0d8-0000-7000-8000-000000000001',
  aggregateType: 'Order',
  aggregateId: ORDER_ID,
  eventType: 'order.refunded',
  payload,
  occurredAt: OCCURRED_AT,
  traceparent: null,
});

describe('formatTotal', () => {
  it('renders minor units in the major units of the currency', () => {
    expect([formatTotal(21_000_000, 'VND'), formatTotal(1999, 'USD')]).toEqual(['₫21,000,000', '$19.99']);
  });

  it.each([
    ['a missing amount', undefined, 'VND'],
    ['an amount that is not finite', Number.NaN, 'VND'],
    ['a currency that is not a code', 1000, 'vnd'],
    ['no currency', 1000, undefined],
  ])('answers null for %s', (_case, amount, currency) => {
    expect(formatTotal(amount, currency)).toBeNull();
  });
});

describe('recipientOf', () => {
  it('reads the buyer as of when the event happened', async () => {
    const find = vi.fn<UserContactPort['find']>().mockResolvedValue({ email: 'buyer@test.local' });

    await expect(recipientOf(job({ orderId: ORDER_ID, userId: USER_ID }), { find })).resolves.toEqual({
      orderId: ORDER_ID,
      email: 'buyer@test.local',
    });
    expect(find).toHaveBeenCalledWith(USER_ID, new Date(OCCURRED_AT));
  });

  it('refuses permanently, naming the event, when the payload carries no ids', async () => {
    const find = vi.fn<UserContactPort['find']>();

    await expect(recipientOf(job({ orderId: ORDER_ID }), { find })).rejects.toThrow(
      new PermanentError(
        'order.refunded without an orderId/userId to confirm (message 0198f0d8-0000-7000-8000-000000000001)',
      ),
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('refuses permanently when the buyer no longer exists', async () => {
    const find = vi.fn<UserContactPort['find']>().mockResolvedValue(null);

    await expect(recipientOf(job({ orderId: ORDER_ID, userId: USER_ID }), { find })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  // A directory that cannot answer now is not a verdict on the event: the delivery retries.
  it('lets a directory outage through for the retry ladder', async () => {
    const outage = new Error('user-service unavailable');
    const find = vi.fn<UserContactPort['find']>().mockRejectedValue(outage);

    await expect(recipientOf(job({ orderId: ORDER_ID, userId: USER_ID }), { find })).rejects.toBe(outage);
  });
});

describe('sendOnceAfterCommit', () => {
  const failure = { kind: 'order_refunded' as const, context: { orderId: ORDER_ID }, message: 'not delivered' };

  it('sends nothing until the effect runs, then sends once', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const metrics = fakeMetricsPort();

    const effect = sendOnceAfterCommit(
      { mailTransport: { sendMail }, metrics, logger: fakePinoLogger() },
      MESSAGE,
      failure,
    );
    expect(sendMail).not.toHaveBeenCalled();

    await effect();
    expect(sendMail).toHaveBeenCalledExactlyOnceWith(MESSAGE);
    expect(metrics.recordMailSendFailure).not.toHaveBeenCalled();
  });

  it('counts and logs a failed send by its kind, and never throws', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('smtp down'));
    const metrics = fakeMetricsPort();
    const error = vi.fn();

    const effect = sendOnceAfterCommit(
      { mailTransport: { sendMail }, metrics, logger: fakePinoLogger({ error }) },
      MESSAGE,
      failure,
    );

    await expect(effect()).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(metrics.recordMailSendFailure).toHaveBeenCalledExactlyOnceWith('order_refunded');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, err: expect.any(Error) as unknown }),
      'not delivered',
    );
  });
});
