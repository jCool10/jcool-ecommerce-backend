import { UnrecoverableError } from 'bullmq';

/**
 * A failure no redelivery can repair: a malformed envelope, a payload the handler cannot make sense
 * of, an event nothing is registered for. Retrying it burns the attempt budget and only delays the
 * message reaching somewhere a human will look at it.
 *
 * Extends BullMQ's `UnrecoverableError` because that is exactly what its retry check tests for
 * (`err instanceof UnrecoverableError || err.name === 'UnrecoverableError'`), so throwing this
 * skips the remaining attempts without anything downstream having to re-derive the decision.
 *
 * Only the `instanceof` half of that check matches — the name stays specific, because it is what a
 * human reads in a log line. That is safe as long as the error reaches BullMQ as an object rather
 * than as JSON, which the processor guarantees: it is a closure over Nest-injected dependencies and
 * therefore cannot run in a sandboxed (separate-process) processor. Move it into one and the name
 * becomes load-bearing.
 */
export class PermanentError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/**
 * An event reached the consumer with no handler registered for its type — a producer shipped ahead
 * of its consumer. Permanent on purpose: no handler is going to appear inside a retry budget
 * measured in seconds, so the useful move is to park it in the dead-letter queue and replay it once
 * the consumer that understands it has been deployed.
 */
export class UnhandledEventError extends PermanentError {
  constructor(readonly eventType: string) {
    super(`No handler registered for domain event "${eventType}"`);
    this.name = 'UnhandledEventError';
  }
}
