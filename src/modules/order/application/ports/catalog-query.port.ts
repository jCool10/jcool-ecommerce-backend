// Order's own view of a SKU (anti-corruption boundary), resolved live from Catalog
// at order-creation time to snapshot price/name into the order. The infrastructure
// adapter implements this by delegating to Catalog's published CATALOG_SKU_QUERY;
// Order never imports Catalog's domain/infrastructure. Mirrors Cart's identical
// wrapper — each context owns its own translation of Catalog's language.
export const CATALOG_QUERY = Symbol('ORDER_CATALOG_QUERY');

/** Live projection of one SKU as Order needs it to snapshot a line. */
export interface OrderSkuView {
  skuId: string;
  productName: string;
  /** Integer smallest-unit price; null when the SKU has no price (not purchasable). */
  unitPriceMinor: number | null;
  currency: string;
  isActive: boolean;
}

export interface CatalogQueryPort {
  /** One SKU's live view by variant id; null if no such SKU exists in Catalog. */
  getSkuView(skuId: string): Promise<OrderSkuView | null>;
}
