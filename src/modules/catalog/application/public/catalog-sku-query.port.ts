/**
 * Catalog's published SKU-read language — a cross-context surface (importable
 * from another bounded context, per `.dependency-cruiser.cjs`). Returns a plain
 * snapshot, never a domain entity or a row. Added for its first real consumer
 * (Cart, which needs live SKU price/name for its subtotal), exactly as the
 * facade note anticipated — YAGNI kept this out until now.
 */
export const CATALOG_SKU_QUERY = Symbol('CATALOG_SKU_QUERY');

/** Live projection of one sellable unit (product variant) for cross-context reads. */
export interface SkuView {
  /** The product-variant id (the stable SKU identity Inventory/Cart reference). */
  skuId: string;
  productName: string;
  /** Integer smallest-unit price for `currency`; null when the SKU has no price. */
  unitPriceMinor: number | null;
  currency: string;
  /** True only when the product is ACTIVE and the variant is not archived. */
  isActive: boolean;
}

export interface CatalogSkuQuery {
  /** One SKU's live view by variant id; null if no such variant exists. */
  getSkuView(skuId: string): Promise<SkuView | null>;
}
