import { DomainError } from '@jcool/kernel';

/** A bounded stock transaction ran out of time and rolled back; nothing it wrote survived. */
export class ReservationTimeoutError extends DomainError {
  constructor(public readonly timeoutMs: number) {
    super(`Stock transaction did not finish within ${timeoutMs}ms`);
    this.name = 'ReservationTimeoutError';
  }
}
