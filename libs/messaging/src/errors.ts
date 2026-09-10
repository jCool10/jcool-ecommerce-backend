import { UnrecoverableError } from 'bullmq';

/**
 * A failure no redelivery can repair; retrying it only burns the attempt budget. Extends BullMQ's
 * `UnrecoverableError` because its retry check is exactly
 * `err instanceof UnrecoverableError || err.name === 'UnrecoverableError'` — and only the
 * `instanceof` half matches here, which stops being safe if this ever runs in a sandboxed
 * (separate-process) processor, where the error reaches BullMQ as JSON and the name becomes load-bearing.
 */
export class PermanentError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/**
 * A producer shipped ahead of its consumer. Permanent on purpose: no handler will appear inside a
 * retry budget measured in seconds, so the useful move is to park it in the DLQ and replay it once
 * the consumer that understands it has been deployed.
 */
export class UnhandledEventError extends PermanentError {
  constructor(readonly eventType: string) {
    super(`No handler registered for domain event "${eventType}"`);
    this.name = 'UnhandledEventError';
  }
}
