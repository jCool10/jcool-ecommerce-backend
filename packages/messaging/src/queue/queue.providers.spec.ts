import { describe, expect, it } from 'vitest';
import { CATALOG, ORDERS, ROUTES } from '../testing/messaging-fixtures';
import { queueNamesOf } from './queue.providers';

const consumed = (spec: typeof ORDERS, dlq = spec.dlq) => ({ ...spec, dlq, consumer: spec.name, dispatcher: 'd' });

describe('queueNamesOf', () => {
  it('opens only the routed queues for a process that consumes nothing', () => {
    expect(queueNamesOf(ROUTES, [])).toEqual({ main: ['orders', 'catalog'], dlq: [] });
  });

  it('adds a consumed queue nothing here publishes to, and the dead letters of each consumed queue', () => {
    expect(queueNamesOf({ 'order.placed': ORDERS }, [consumed(ORDERS), consumed(CATALOG)])).toEqual({
      main: ['orders', 'catalog'],
      dlq: ['orders-dlq', 'catalog-dlq'],
    });
  });

  it('refuses a consumed queue whose dead letters go somewhere its route does not', () => {
    expect(() => queueNamesOf(ROUTES, [consumed(ORDERS, 'elsewhere-dlq')])).toThrow(/orders-dlq.*elsewhere-dlq/);
  });
});
