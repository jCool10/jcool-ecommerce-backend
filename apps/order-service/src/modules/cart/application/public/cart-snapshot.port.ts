/**
 * Cart's published cross-context surface (importable from another bounded context, per
 * `.dependency-cruiser.cjs`). Pricing is deliberately absent — a consumer that needs price
 * (Order, to freeze it) resolves it from Catalog itself.
 */
export const CART_SNAPSHOT = Symbol('CART_SNAPSHOT');

export interface CartSnapshotLine {
  skuId: string;
  quantity: number;
}

export interface CartSnapshotReader {
  /** Empty array when the cart is empty or does not exist yet. */
  getLines(userId: string): Promise<CartSnapshotLine[]>;
}
