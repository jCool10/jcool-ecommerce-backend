import type { CartItem } from '../../domain/cart-item.entity';

// The application layer must stay free of drizzle-orm/schema; the adapter in infrastructure/ owns it.
export const CART_REPOSITORY = Symbol('CART_REPOSITORY');

export interface CartRepositoryPort {
  /** The user's cart id, creating an empty cart if none exists (idempotent, race-safe). */
  ensureCartId(userId: string): Promise<string>;

  findItems(cartId: string): Promise<CartItem[]>;

  /**
   * Accumulates onto an existing line — one row per SKU. Lossy at the ceiling: the stored line
   * quantity is clamped to MAX_LINE_QUANTITY, so an add can persist less than it asked for.
   */
  addItem(cartId: string, skuId: string, quantity: number): Promise<void>;

  /** False when the SKU is not in the cart. */
  setItemQuantity(cartId: string, skuId: string, quantity: number): Promise<boolean>;

  /** Idempotent — no error when the SKU is absent. */
  removeItem(cartId: string, skuId: string): Promise<void>;

  clear(cartId: string): Promise<void>;
}
