import { UnhandledEventError } from '../errors';
import type { DomainEventJob, PostCommitEffect } from '../queue/domain-event.job';
import type {
  Consumer,
  Consumers,
  DomainEventDispatcherPort,
  QueueSpec,
  TransactionalStep,
} from '../queue/queue-definition';

export type FakeHandler = (job: DomainEventJob) => Promise<TransactionalStep<unknown>>;

/** Recording in-transaction work, and an effect when one is given. */
export const inTransaction =
  (record: (job: DomainEventJob) => Promise<void> = () => Promise.resolve(), effect?: PostCommitEffect): FakeHandler =>
  (job) =>
    Promise.resolve(async () => {
      await record(job);
      return effect;
    });

export function fakeDispatcher(handlers: Record<string, FakeHandler>): DomainEventDispatcherPort {
  return {
    handles: (eventType) => Object.hasOwn(handlers, eventType),
    prepare: (job) => {
      if (!Object.hasOwn(handlers, job.eventType)) return Promise.reject(new UnhandledEventError(job.eventType));
      return handlers[job.eventType](job);
    },
  };
}

export function consumersOf(
  ...queues: { spec: QueueSpec; consumer?: string; dispatcher: DomainEventDispatcherPort }[]
): Consumers {
  return new Map(
    queues.map(({ spec, consumer, dispatcher }): [string, Consumer] => [
      spec.name,
      { definition: { ...spec, consumer: consumer ?? spec.name, dispatcher: Symbol(spec.name) }, dispatcher },
    ]),
  );
}
