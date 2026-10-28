/**
 * The command ran out of its time budget (lock wait, statement, or the pool wait before it). Transient,
 * so deliberately not a `DomainError`: the filter would answer 422 for a condition a retry may clear.
 */
export class ReservationTimeoutError extends Error {
  constructor(message = 'Stock reservation exceeded its time budget') {
    super(message);
    this.name = 'ReservationTimeoutError';
  }
}
