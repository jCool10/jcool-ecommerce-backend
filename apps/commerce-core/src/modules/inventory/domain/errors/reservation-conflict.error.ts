import { DomainError } from '@shared/kernel';

/**
 * The SKU still has stock but writers are contending. Distinct from InsufficientStockError so the
 * HTTP boundary can answer 409 "retry" instead of a hard sold-out.
 */
export class ReservationConflictError extends DomainError {
  constructor(public readonly variantId: string) {
    super(`Reservation conflict for ${variantId}: exceeded optimistic retry budget`);
    this.name = 'ReservationConflictError';
  }
}
