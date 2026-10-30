import { vi } from 'vitest';
import type { DomainEventJob } from '@jcool/messaging';
import type { DrizzleTx } from '../../src/database';
import type { OrderEventsDispatcher, TransactionalStep } from '../../src/shared/messaging/order-events.handlers';

/**
 * The part of a delivery that runs inside the consumer transaction, as one spy. It calls through to
 * the real handler until a test mocks it to fail or to stall there.
 */
export function spyOnEffect(dispatcher: OrderEventsDispatcher) {
  const prepare = dispatcher.prepare.bind(dispatcher);
  const effect = vi.fn(async (job: DomainEventJob, tx: DrizzleTx) => (await prepare(job))(tx));
  vi.spyOn(dispatcher, 'prepare').mockImplementation((job): Promise<TransactionalStep> =>
    Promise.resolve((tx) => effect(job, tx)),
  );
  return effect;
}
