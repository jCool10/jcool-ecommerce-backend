import { assertInteger, assertNonEmpty, assertPositive } from '@shared/kernel';

/**
 * One line in a cart: which SKU (product-variant id) and how many. Cart is
 * scratch space, so a line carries no price — the live price is resolved from
 * Catalog at read time. Quantity is a domain invariant (integer >= 1), mirrored
 * by the DTO validation at the HTTP edge.
 */
export class CartItem {
  private constructor(
    public readonly skuId: string,
    public readonly quantity: number,
  ) {}

  static of(skuId: string, quantity: number): CartItem {
    assertNonEmpty(skuId, 'CartItem.skuId');
    assertInteger(quantity, 'CartItem.quantity');
    assertPositive(quantity, 'CartItem.quantity');
    return new CartItem(skuId, quantity);
  }
}
