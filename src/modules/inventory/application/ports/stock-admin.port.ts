// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { StockView } from './stock-repository.port';

export type { StockView };

/**
 * The operator's write side of stock, deliberately separate from STOCK_RESERVATION — that port is
 * Inventory's published language for Order (hold, commit, release), and putting a goods-receipt on
 * it would hand every consumer the ability to rewrite stock.
 */
export const STOCK_ADMIN = Symbol('STOCK_ADMIN');

export interface StockAdminPort {
  /** Null when the SKU has no stock row yet — never seeded, never received. */
  getLevel(variantId: string): Promise<StockView | null>;

  /**
   * Absolute on-hand, creating the row when the SKU has none. An upsert because a variant created
   * through the admin catalog API has no `stock_levels` row at all — only the seeders write one — so
   * an UPDATE would match zero rows and answer 200 having done nothing.
   */
  setOnHand(variantId: string, quantity: number): Promise<StockView>;

  /** Relative change, applied in one statement. Null when the SKU has no stock row. */
  adjust(variantId: string, delta: number): Promise<StockView | null>;
}
