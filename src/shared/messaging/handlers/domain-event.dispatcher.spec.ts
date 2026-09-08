import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { OrderPaidMailHandler } from '@modules/order/interface/queue/order-paid-mail.handler';
import type { PaymentEventsHandler } from '@modules/order/interface/queue/payment-events.handler';
import type { OrderCancelledHandler } from '@modules/payment/interface/queue/order-cancelled.handler';
import type { OrderExpiredHandler } from '@modules/payment/interface/queue/order-expired.handler';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { UnhandledEventError } from '../errors';
import type { DomainEventJob } from '../queue/domain-event.job';
import { DomainEventDispatcher } from './domain-event.dispatcher';
import { OrderEventsHandler } from './order-events.handler';

const tx = Symbol('tx') as unknown as DrizzleTx;

function job(eventType: string): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Order',
    aggregateId: '0198f0d8-1111-7000-8000-000000000001',
    eventType,
    payload: {},
    occurredAt: '2026-08-24T00:00:00.000Z',
    traceparent: null,
  };
}

function build() {
  const info = vi.fn();
  const settle = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const closeCancelled = vi.fn().mockResolvedValue(undefined);
  const sendMail = vi.fn().mockResolvedValue(undefined);
  const prepare = vi.fn().mockResolvedValue(sendMail);
  const handler = new OrderEventsHandler({ info } as unknown as PinoLogger);
  return {
    dispatcher: new DomainEventDispatcher(
      handler,
      { settle } as unknown as PaymentEventsHandler,
      { close } as unknown as OrderExpiredHandler,
      { close: closeCancelled } as unknown as OrderCancelledHandler,
      { prepare } as unknown as OrderPaidMailHandler,
    ),
    info,
    settle,
    close,
    closeCancelled,
    prepare,
    sendMail,
  };
}

describe('DomainEventDispatcher', () => {
  // Every event the order context emits today. A producer that starts emitting one more without
  // registering it here should fail this test, not discover it in the dead-letter queue.
  it.each(['order.placed', 'order.paid', 'order.failed', 'order.expired', 'order.cancelled'])(
    'audits %s',
    async (eventType) => {
      const { dispatcher, info } = build();

      await dispatcher.dispatch(job(eventType), tx);

      expect(info).toHaveBeenCalledWith(expect.objectContaining({ eventType }), 'order event consumed');
    },
  );

  // The caller owns when it runs, and that is after the transaction this dispatch is inside commits.
  it('returns the buyer confirmation from order.paid without sending it', async () => {
    const { dispatcher, prepare, sendMail } = build();

    const effect = await dispatcher.dispatch(job('order.paid'), tx);

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order.paid' }));
    expect(sendMail).not.toHaveBeenCalled();
    expect(effect).toBe(sendMail);
  });

  it.each(['order.placed', 'order.failed', 'order.cancelled', 'payment.succeeded'])(
    'returns nothing for %s, which owes no work outside the transaction',
    async (eventType) => {
      const { dispatcher } = build();
      await expect(dispatcher.dispatch(job(eventType), tx)).resolves.toBeUndefined();
    },
  );

  it('routes order.expired to the payment session close, on the consumer tx', async () => {
    const { dispatcher, info, close } = build();

    await dispatcher.dispatch(job('order.expired'), tx);

    expect(info).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order.expired' }), 'order event consumed');
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order.expired' }), tx);
  });

  it('fails the whole expiry when the session cannot be closed, so the redelivery retries it', async () => {
    const { dispatcher, close } = build();
    close.mockRejectedValue(new Error('gateway unreachable'));

    await expect(dispatcher.dispatch(job('order.expired'), tx)).rejects.toThrow('gateway unreachable');
  });

  it('routes order.cancelled to its own payment session close, on the consumer tx', async () => {
    const { dispatcher, info, close, closeCancelled } = build();

    await dispatcher.dispatch(job('order.cancelled'), tx);

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'order.cancelled' }),
      'order event consumed',
    );
    expect(closeCancelled).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order.cancelled' }), tx);
    expect(close).not.toHaveBeenCalled();
  });

  it('fails the whole cancel when the session cannot be closed, so the redelivery retries it', async () => {
    const { dispatcher, closeCancelled } = build();
    closeCancelled.mockRejectedValue(new Error('gateway unreachable'));

    await expect(dispatcher.dispatch(job('order.cancelled'), tx)).rejects.toThrow('gateway unreachable');
  });

  it.each(['payment.succeeded', 'payment.failed'])(
    'routes %s to the order settlement, on the consumer tx',
    async (eventType) => {
      const { dispatcher, settle } = build();

      await dispatcher.dispatch(job(eventType), tx);

      expect(settle).toHaveBeenCalledWith(expect.objectContaining({ eventType }), tx);
    },
  );

  it('refuses an event it has no handler for rather than acknowledging it', async () => {
    const { dispatcher } = build();

    await expect(dispatcher.dispatch(job('cart.abandoned'), tx)).rejects.toBeInstanceOf(UnhandledEventError);
  });

  it('folds an unregistered name into one label, so a bad producer cannot mint time series', () => {
    const { dispatcher } = build();

    expect(dispatcher.label('order.paid')).toBe('order.paid');
    expect(dispatcher.label('order.paid; DROP TABLE')).toBe('unregistered');
  });
});
