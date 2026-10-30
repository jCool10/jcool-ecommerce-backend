import { describe, expect, it, vi } from 'vitest';
import { type DomainEventJob, UnhandledEventError, eventLabel } from '@jcool/messaging';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '../../database';
import type { OrderFinalizedEvent } from '../../modules/order/domain/order.entity';
import type { OrderPaidMailHandler } from '../../modules/order/interface/queue/order-paid-mail.handler';
import type { PaymentAuthorizedHandler } from '../../modules/order/interface/queue/payment-authorized.handler';
import { OrderEventsAudit, OrderEventsDispatcher } from './order-events.handlers';

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

// Everything order-events carries: this service's own events and the payment-service's.
const DELIVERED_EVENT_TYPES = Object.keys({
  'order.placed': true,
  'order.paid': true,
  'order.failed': true,
  'order.expired': true,
  'order.cancelled': true,
  'payment.authorized': true,
} satisfies Record<OrderFinalizedEvent['eventName'] | 'order.placed' | 'payment.authorized', true>);

interface Doubles {
  audit?: OrderEventsAudit;
  forwardAuthorization?: PaymentAuthorizedHandler['forward'];
  prepareMail?: OrderPaidMailHandler['prepare'];
}

const dispatcherWith = ({ audit, forwardAuthorization, prepareMail }: Doubles = {}) =>
  new OrderEventsDispatcher(
    audit ?? new OrderEventsAudit(fakePinoLogger()),
    { forward: forwardAuthorization ?? vi.fn() } as unknown as PaymentAuthorizedHandler,
    { prepare: prepareMail ?? vi.fn() } as unknown as OrderPaidMailHandler,
  );

const run = async (dispatcher: OrderEventsDispatcher, event: DomainEventJob) => (await dispatcher.prepare(event))(tx);

describe('OrderEventsDispatcher', () => {
  it('handles every event order-events delivers, and no catalog event', () => {
    const dispatcher = dispatcherWith();

    expect(DELIVERED_EVENT_TYPES.filter((type) => !dispatcher.handles(type))).toEqual([]);
    expect(dispatcher.handles('catalog.product.changed')).toBe(false);
  });

  // A signal to Temporal cannot roll back with the claim; it must land before the claim commits.
  it('forwards payment.authorized before the transaction and leaves the step empty', async () => {
    const forwardAuthorization = vi.fn().mockResolvedValue(undefined);
    const guarded = new Proxy({} as DrizzleTx, {
      get: () => {
        throw new Error('payment.authorized must not use the transaction');
      },
    });

    const step = await dispatcherWith({ forwardAuthorization }).prepare(job('payment.authorized'));
    expect(forwardAuthorization).toHaveBeenCalledOnce();

    await expect(step(guarded)).resolves.toBeUndefined();
  });

  it('fails the prepare when the authorization cannot be forwarded', async () => {
    const outage = new Error('temporal unavailable');
    const dispatcher = dispatcherWith({ forwardAuthorization: vi.fn().mockRejectedValue(outage) });

    await expect(dispatcher.prepare(job('payment.authorized'))).rejects.toBe(outage);
  });

  // The address comes from the user-service, and that call must not hold the consumer's connection.
  it('prepares the order.paid mail before the transaction and hands it back unsent', async () => {
    const sendMail = vi.fn();
    const prepareMail = vi.fn().mockResolvedValue(sendMail);

    const step = await dispatcherWith({ prepareMail }).prepare(job('order.paid'));
    expect(prepareMail).toHaveBeenCalledOnce();

    await expect(step(tx)).resolves.toBe(sendMail);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('only records the order events the saga already applied', async () => {
    const info = vi.fn();
    const dispatcher = dispatcherWith({ audit: new OrderEventsAudit(fakePinoLogger({ info })) });
    const events = ['order.placed', 'order.failed', 'order.expired', 'order.cancelled'];

    for (const eventType of events) {
      await expect(run(dispatcher, job(eventType))).resolves.toBeUndefined();
    }

    const [first] = info.mock.calls[0] as [Record<string, unknown>];
    expect(first).toEqual({
      eventType: 'order.placed',
      orderId: job('order.placed').aggregateId,
      messageId: job('order.placed').outboxId,
      occurredAt: job('order.placed').occurredAt,
    });
    expect(info.mock.calls.map(([fields]) => (fields as { eventType: string }).eventType)).toEqual(events);
  });

  it('refuses an event it has no handler for', async () => {
    await expect(dispatcherWith().prepare(job('catalog.product.changed'))).rejects.toBeInstanceOf(UnhandledEventError);
  });

  // A name off the wire is unbounded; as a metric label it would mint a time series per value.
  it('folds an unregistered event type into one label', () => {
    expect(['order.paid', 'order.paid; DROP TABLE'].map((type) => eventLabel(dispatcherWith(), type))).toEqual([
      'order.paid',
      'unregistered',
    ]);
  });
});
