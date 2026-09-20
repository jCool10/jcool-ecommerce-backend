import { vi } from 'vitest';
import type { DrizzleTx } from '../../src/shared/infrastructure/database/drizzle.tokens';
import type {
  DomainEventDispatcher,
  DomainEventHandler,
} from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';

/**
 * The part of a delivery that runs inside the consumer transaction, as one spy. It calls through to
 * the real handler until a test mocks it to fail or to stall there.
 */
export function spyOnEffect(dispatcher: DomainEventDispatcher) {
  const prepare = dispatcher.prepare.bind(dispatcher) as DomainEventDispatcher['prepare'];
  const effect = vi.fn<DomainEventHandler>(async (job: DomainEventJob, tx: DrizzleTx) => (await prepare(job))(tx));
  vi.spyOn(dispatcher, 'prepare').mockImplementation((job) => Promise.resolve((tx) => effect(job, tx)));
  return effect;
}
