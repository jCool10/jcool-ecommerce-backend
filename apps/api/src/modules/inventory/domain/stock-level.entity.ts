import { assertInteger, assertNonEmpty } from '@shared/kernel';
import { InsufficientStockError } from './errors/insufficient-stock.error';

/**
 * A pure read/derivation model for a SKU's stock (`available = onHand − reserved`, never stored).
 * NOT on the write path: "never oversell" is enforced in StockRepository — the row lock or CAS
 * predicate, backed by the `ck_stock_no_oversell` CHECK. Changing `reserve()` here changes nothing
 * about reservation behaviour.
 */
export class StockLevel {
  private constructor(
    public readonly variantId: string,
    private _quantityOnHand: number,
    private _quantityReserved: number,
    private _version: number,
  ) {}

  static rehydrate(props: {
    variantId: string;
    quantityOnHand: number;
    quantityReserved: number;
    version: number;
  }): StockLevel {
    assertNonEmpty(props.variantId, 'StockLevel.variantId');
    assertInteger(props.quantityOnHand, 'StockLevel.quantityOnHand');
    assertInteger(props.quantityReserved, 'StockLevel.quantityReserved');
    assertInteger(props.version, 'StockLevel.version');
    return new StockLevel(props.variantId, props.quantityOnHand, props.quantityReserved, props.version);
  }

  get quantityOnHand(): number {
    return this._quantityOnHand;
  }

  get quantityReserved(): number {
    return this._quantityReserved;
  }

  get version(): number {
    return this._version;
  }

  availableQuantity(): number {
    return this._quantityOnHand - this._quantityReserved;
  }

  canReserve(qty: number): boolean {
    return Number.isInteger(qty) && qty >= 1 && this.availableQuantity() >= qty;
  }

  reserve(qty: number): void {
    if (!this.canReserve(qty)) {
      throw new InsufficientStockError(this.variantId, qty, this.availableQuantity());
    }
    this._quantityReserved += qty;
    this._version += 1;
  }
}
