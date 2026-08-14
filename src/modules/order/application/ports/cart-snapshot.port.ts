// Order's own view of "the current cart to turn into an order" — an anti-corruption
// boundary. The infrastructure adapter implements this by delegating to Cart's
// published CART_SNAPSHOT port; Order never imports Cart's domain/infrastructure.
// Cart lines are raw { skuId, quantity } (no price) — Order resolves price/name
// itself from Catalog at snapshot time (its price is the transactional truth).
export const CART_SNAPSHOT_READER = Symbol('ORDER_CART_SNAPSHOT_READER');

/** One raw cart line as Order consumes it. */
export interface OrderCartLine {
  skuId: string;
  quantity: number;
}

export interface CartSnapshotReaderPort {
  /** The user's current cart lines; empty array when the cart is empty/absent. */
  getLines(userId: string): Promise<OrderCartLine[]>;
}
