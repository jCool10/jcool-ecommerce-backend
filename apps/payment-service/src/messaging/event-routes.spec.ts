import { describe, expect, it } from 'vitest';
import { PAYMENT_AUTHORIZED_EVENT } from '@jcool/internal-contracts/events/payment-authorized';
import { ORDER_PAID_BACKOFF } from '@jcool/internal-contracts/queues/order-events';
import { routeOf } from '@jcool/messaging';
import { PAYMENT_EVENT_ROUTES } from './event-routes';

describe('payment event routes', () => {
  // The api's consumer signals Temporal; a short ladder would dead-letter a paid order in a brief outage.
  it('sends payment.authorized to order-events on the long ladder', () => {
    const route = routeOf(PAYMENT_EVENT_ROUTES, PAYMENT_AUTHORIZED_EVENT);

    expect(route).toMatchObject({ name: 'order-events', dlq: 'order-events-dlq' });
    expect(route?.jobOptionsFor(PAYMENT_AUTHORIZED_EVENT, 12)).toEqual({
      attempts: 12,
      backoff: { type: ORDER_PAID_BACKOFF },
    });
  });

  it('routes nothing else', () => {
    expect(Object.keys(PAYMENT_EVENT_ROUTES)).toEqual([PAYMENT_AUTHORIZED_EVENT]);
  });
});
