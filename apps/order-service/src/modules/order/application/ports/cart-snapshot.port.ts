// Anti-corruption boundary: Order never imports Cart's domain/infrastructure. Cart lines carry no
// price — Order resolves price/name itself from Catalog at snapshot time, which is the
// transactional truth.
export const CART_SNAPSHOT_READER = Symbol('ORDER_CART_SNAPSHOT_READER');

export interface OrderCartLine {
  skuId: string;
  quantity: number;
}

export interface CartSnapshotReaderPort {
  /** Empty array when the cart is empty or absent. */
  getLines(userId: string): Promise<OrderCartLine[]>;
}
