/**
 * The command ran out of time for a reason other than waiting on a lock: a slow statement, or a pool
 * wait that left nothing of the budget. Unlike a ReservationTimeoutError this says the service is
 * unwell, so it answers a bare 503 that the caller's breaker counts.
 */
export class ReservationDeadlineError extends Error {
  constructor(message = 'Stock reservation ran out of time before it could start or finish', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReservationDeadlineError';
  }
}
