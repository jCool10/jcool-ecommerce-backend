/**
 * Anti-corruption boundary against Catalog's published language: Cart reads Catalog only through
 * this port, never its repository. An infrastructure adapter maps Catalog's `SkuView` into it, so a
 * change to Catalog's contract stops at the adapter instead of rippling through Cart.
 */
export const CATALOG_QUERY = Symbol('CART_CATALOG_QUERY');

export interface CartSkuView {
  skuId: string;
  productName: string;
  /** null when the SKU is unpriced. */
  unitPriceMinor: number | null;
  currency: string;
  /** True only when the product is ACTIVE and the variant is not archived. */
  isActive: boolean;
}

export interface CatalogQueryPort {
  /** Keyed by variant id; null when Catalog has no such SKU. */
  getSkuView(skuId: string): Promise<CartSkuView | null>;

  /**
   * An id Catalog does not know is absent from the result, and the order is Catalog's — key the
   * result by `skuId`, never by position.
   */
  getSkuViews(skuIds: string[]): Promise<CartSkuView[]>;
}
