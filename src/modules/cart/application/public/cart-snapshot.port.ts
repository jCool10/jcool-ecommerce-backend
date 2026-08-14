/**
 * Cart's published snapshot language — a cross-context surface (importable from
 * another bounded context, per `.dependency-cruiser.cjs`). Returns RAW lines only
 * ({ skuId, quantity }); pricing is deliberately NOT here — a consumer that needs
 * price (Order, to freeze it) resolves that itself from Catalog. Added for its
 * first consumer (Order snapshotting the cart into an order).
 */
export const CART_SNAPSHOT = Symbol('CART_SNAPSHOT');

/** One raw cart line for cross-context reads (no price — cart is scratch space). */
export interface CartSnapshotLine {
  skuId: string;
  quantity: number;
}

export interface CartSnapshotReader {
  /** The user's current cart lines; empty array when the cart is empty/absent. */
  getLines(userId: string): Promise<CartSnapshotLine[]>;
}
