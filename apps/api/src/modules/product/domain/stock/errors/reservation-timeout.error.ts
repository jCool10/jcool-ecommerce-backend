import { DomainError } from '@jcool/kernel';

/** A reservation call ran out of its time budget; nothing it wrote survives. */
export class ReservationTimeoutError extends DomainError {
  constructor(public readonly timeoutMs: number) {
    super(`Reservation did not complete within ${timeoutMs}ms`);
    this.name = 'ReservationTimeoutError';
  }
}
