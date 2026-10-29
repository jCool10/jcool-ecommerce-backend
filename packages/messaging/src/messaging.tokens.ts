/** Held separately because BullMQ never closes a client it was handed. */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/** Every queue this process publishes to, plus the dead-letter queue of each it consumes, by name. */
export const MESSAGING_QUEUES = Symbol('MESSAGING_QUEUES');

export const MESSAGING_OPTIONS = Symbol('MESSAGING_OPTIONS');

export const MESSAGING_ID_GENERATOR = Symbol('MESSAGING_ID_GENERATOR');

/** Each consumed queue's definition and its resolved dispatcher, by queue name. */
export const MESSAGING_CONSUMERS = Symbol('MESSAGING_CONSUMERS');

/** One queue by name, for wiring and tests that inspect what was published. */
export const queueToken = (name: string): string => `messaging:queue:${name}`;
