import { assertInteger, assertNonEmpty, assertPositive, DomainError, Money } from '@shared/kernel';

/**
 * One line of an order — a PRICE SNAPSHOT taken when the order is created. Unlike
 * a cart line (which carries only { skuId, quantity } and reads price live), an
 * order line copies `productName` and `unitPriceMinor` at creation time. This is
 * the transactional source of truth: a later Catalog price/name change must NOT
 * alter a placed order. Currency is held once at the order level.
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

  /** unit × quantity as Money in the order's currency. */
  lineTotal(currency: string): Money {
    return Money.of(this.unitPriceMinor, currency).multiply(this.quantity);
  }
}
