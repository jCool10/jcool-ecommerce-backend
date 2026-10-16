/** A failure no redelivery can repair; retrying it only burns the attempt budget. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/**
 * A producer shipped ahead of its consumer. Permanent on purpose: no handler will appear inside the
 * retry ladder, so the useful move is to dead-letter it and replay it once the consumer that
 * understands it has been deployed.
 */
export class UnhandledEventError extends PermanentError {
  constructor(readonly eventType: string) {
    super(`No handler registered for domain event "${eventType}"`);
    this.name = 'UnhandledEventError';
  }
}
