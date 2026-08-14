import type { CartItem } from '../../domain/cart-item.entity';

// Cart persistence port; the Drizzle adapter implements it in infrastructure/.
// Keeps the application free of drizzle-orm/schema. Operations are keyed by the
// user's single active cart (auto-created via `ensureCartId`).
export const CART_REPOSITORY = Symbol('CART_REPOSITORY');

export interface CartRepositoryPort {
  /** The user's cart id, creating an empty cart if none exists (idempotent, race-safe). */
  ensureCartId(userId: string): Promise<string>;

  /** All lines in a cart as domain entities. */
  findItems(cartId: string): Promise<CartItem[]>;

  /** Add `quantity` of a SKU, accumulating onto an existing line (one row per SKU). */
  addItem(cartId: string, skuId: string, quantity: number): Promise<void>;

  /** Set a line's absolute quantity; false when the SKU is not in the cart. */
  setItemQuantity(cartId: string, skuId: string, quantity: number): Promise<boolean>;

  /** Remove a SKU's line (idempotent — no error if absent). */
  removeItem(cartId: string, skuId: string): Promise<void>;

  /** Remove every line from the cart. */
  clear(cartId: string): Promise<void>;
}
