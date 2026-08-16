import { DomainError } from '@shared/kernel';

/**
 * Raised when a reserve asks for more than a SKU's available stock. A domain error
 * (not an HttpException) so the core stays framework-free; the HTTP boundary maps
 * it to a client status. Carries the numbers for a precise, non-leaky message.
 */
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
