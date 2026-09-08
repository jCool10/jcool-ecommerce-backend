import { assertInteger, assertNonEmpty, assertPositive } from '@shared/kernel';

// `skuId` is a product-variant id.
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
