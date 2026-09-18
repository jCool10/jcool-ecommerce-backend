import { DomainError } from '@shared/kernel';

export class InsufficientStockError extends DomainError {
  constructor(
    public readonly variantId: string,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(`Insufficient stock for ${variantId}: requested ${requested}, available ${available}`);
    this.name = 'InsufficientStockError';
  }
}
