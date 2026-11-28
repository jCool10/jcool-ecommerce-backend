export const CATALOG_SKU_QUERY = Symbol('CATALOG_SKU_QUERY');

export interface CatalogSkuView {
  skuId: string;
  productName: string;
  /** Integer minor units; null while the SKU has no price. */
  unitPriceMinor: number | null;
  currency: string;
  /** False once the product is not ACTIVE or the variant is archived; the price stays. */
  isActive: boolean;
}

/** The catalog as this service last heard of it, typically a second or two behind the api. */
export interface CatalogSkuQueryPort {
  getSkuView(skuId: string): Promise<CatalogSkuView | null>;
  /** An id the read model does not hold is left out, in no particular order: key by `skuId`. */
  getSkuViews(skuIds: readonly string[]): Promise<CatalogSkuView[]>;
}
