import type { InjectionToken } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import type { DomainEventJob, PostCommitEffect } from './domain-event.job';

/** Where an event is published, and with which per-event options. */
export interface QueueSpec {
  name: string;
  /** The queue's dead letters; nothing consumes it. */
  dlq: string;
  /**
   * Overrides of the queue defaults, per event. BullMQ stamps them at `add`, so every path that adds
   * a job applies them: the relay and a replay. `longLadderAttempts` is `queue.orderPaidAttempts`.
   */
  jobOptionsFor(eventType: string, longLadderAttempts: number): JobsOptions;
}

/** A queue this process consumes. */
export interface QueueDefinition extends QueueSpec {
  /** The inbox consumer group; two queues never share one, so their claims cannot collide. */
  consumer: string;
  dispatcher: InjectionToken;
}

/**
 * Runs inside the consumer's transaction, the one holding the inbox claim. The transaction is the
 * service's own Drizzle tx; the processor only passes it through.
 */
export type TransactionalStep<Tx = never> = (tx: Tx) => Promise<PostCommitEffect | void>;

export interface DomainEventDispatcherPort {
  /** The bounded set of names the metrics may carry; anything else is labelled `unregistered`. */
  handles(eventType: string): boolean;
  /** Runs before the transaction opens; rejects with `UnhandledEventError` for an unknown event. */
  prepare(job: DomainEventJob): Promise<TransactionalStep>;
}

export const UNREGISTERED_EVENT_LABEL = 'unregistered';

export interface Consumer {
  definition: QueueDefinition;
  dispatcher: DomainEventDispatcherPort;
}

export type Consumers = ReadonlyMap<string, Consumer>;

export function consumerOf(consumers: Consumers, queue: string): Consumer {
  const consumer = consumers.get(queue);
  if (!consumer) throw new Error(`queue ${queue} has no consumer in this process`);
  return consumer;
}

export function eventLabel(dispatcher: DomainEventDispatcherPort, eventType: string): string {
  return dispatcher.handles(eventType) ? eventType : UNREGISTERED_EVENT_LABEL;
}
