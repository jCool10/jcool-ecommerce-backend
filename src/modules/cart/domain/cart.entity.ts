import { Money } from '@shared/kernel';
import { CartItem } from './cart-item.entity';

/**
 * Cart aggregate — a user's scratch list of `{ skuId, quantity }` lines. Pure:
 * no framework/DB imports. It stores no prices; `subtotal` takes live prices
 * (resolved by the application from Catalog) so the total always reflects the
 * current price, never a frozen one (freezing is Order's job).
 */
export class Cart {
  constructor(public readonly items: CartItem[]) {}

  /**
   * Subtotal in `currency`, summing unit×quantity over lines that resolve to a
   * same-currency live price. Unpriced or foreign-currency lines are skipped
   * (Money forbids cross-currency addition by construction). Prices are injected
   * as `Money` by the caller, keeping this pure and DB-free.
   *
   * Gross of availability by design: an inactive/archived SKU that still has a
   * price IS counted. The cart is optimistic scratch space — availability and
   * stock are (re)validated only when an Order is placed (Week 4, BF#1). The
   * per-line `isActive` flag is what signals unavailability to the client.
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
