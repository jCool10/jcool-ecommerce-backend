import { Money } from '@shared/kernel';
import { CartItem } from './cart-item.entity';

export class Cart {
  constructor(public readonly items: CartItem[]) {}

  /**
   * Gross of availability by design: an inactive/archived SKU that still has a price IS counted.
   * The cart is optimistic scratch space — availability and stock are (re)validated only when an
   * Order is placed; the per-line `isActive` flag is what signals unavailability to the client.
   */
  subtotal(currency: string, priceOf: (skuId: string) => Money | null): Money {
    return this.items.reduce((sum, item) => {
      const unit = priceOf(item.skuId);
      if (!unit || unit.currency !== currency) {
        return sum;
      }
      return sum.add(unit.multiply(item.quantity));
    }, Money.zero(currency));
  }
}
