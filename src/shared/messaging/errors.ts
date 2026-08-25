/**
 * An event reached the consumer with no handler registered for its type — a producer shipped ahead
 * of its consumer. Thrown rather than logged-and-acked so the event stays in the queue's failure
 * path instead of disappearing.
 */
export class UnhandledEventError extends Error {
  constructor(readonly eventType: string) {
    super(`No handler registered for domain event "${eventType}"`);
    this.name = 'UnhandledEventError';
  }
}
