import { CATALOG, ORDERS, ROUTES } from '../testing/messaging-fixtures';
import { destinationsOf, routeOf } from './event-routes';

describe('event routes', () => {
  it('finds the queue of a routed event and nothing for any other name', () => {
    expect(routeOf(ROUTES, 'order.paid')).toBe(ORDERS);
    expect(routeOf(ROUTES, 'catalog.product.changed')).toBe(CATALOG);
    expect(routeOf(ROUTES, 'payment.refunded')).toBeUndefined();
    expect(routeOf(ROUTES, 'constructor')).toBeUndefined();
  });

  it('lists each destination once', () => {
    expect(destinationsOf(ROUTES)).toEqual([ORDERS, CATALOG]);
  });

  it('refuses one queue routed with two dead-letter queues', () => {
    expect(() => destinationsOf({ 'order.placed': ORDERS, 'order.paid': { ...ORDERS, dlq: 'elsewhere' } })).toThrow(
      /two dead-letter queues/,
    );
  });
});
