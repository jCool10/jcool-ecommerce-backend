import { assertInteger, assertNonEmpty, assertPositive, DomainError, Money } from '@shared/kernel';

/**
 * A price SNAPSHOT: unlike a cart line, which carries only { skuId, quantity } and reads price live,
 * an order line copies `productName` and `unitPriceMinor` at creation time, so a later Catalog
 * price/name change must not alter a placed order. Currency is held once at the order level.
 */
export class OrderItem {
  private constructor(
    public readonly skuId: string,
    public readonly productName: string,
    public readonly unitPriceMinor: number,
    public readonly quantity: number,
  ) {}

  static of(skuId: string, productName: string, unitPriceMinor: number, quantity: number): OrderItem {
    assertNonEmpty(skuId, 'OrderItem.skuId');
    assertNonEmpty(productName, 'OrderItem.productName');
    assertInteger(unitPriceMinor, 'OrderItem.unitPriceMinor');
    if (unitPriceMinor < 0) {
      throw new DomainError('OrderItem.unitPriceMinor must not be negative');
    }
    assertInteger(quantity, 'OrderItem.quantity');
    assertPositive(quantity, 'OrderItem.quantity');
    return new OrderItem(skuId, productName, unitPriceMinor, quantity);
  }

  lineTotal(currency: string): Money {
    return Money.of(this.unitPriceMinor, currency).multiply(this.quantity);
  }
}
