/**
 * Cart's own view of a SKU — the anti-corruption boundary against Catalog's
 * published language. Cart's application depends on THIS port; an infrastructure
 * adapter maps Catalog's `SkuView` into it, so a change to Catalog's contract
 * stops at the adapter instead of rippling through Cart. The success criterion
 * "Cart reads Catalog only through a port, never its repository" lives here.
 */
export const CATALOG_QUERY = Symbol('CART_CATALOG_QUERY');

export interface CartSkuView {
  skuId: string;
  productName: string;
  /** Integer smallest-unit price for `currency`; null when the SKU is unpriced. */
  unitPriceMinor: number | null;
  currency: string;
  /** True only when the product is ACTIVE and the variant is not archived. */
  isActive: boolean;
}

export interface CatalogQueryPort {
  /** One SKU's live view by variant id; null if no such SKU exists in Catalog. */
  getSkuView(skuId: string): Promise<CartSkuView | null>;

  /**
   * Every line of a cart in one read. An id Catalog does not know is absent from the result, and
   * the order is Catalog's — key the result by `skuId`, never by position.
   */
  getSkuViews(skuIds: string[]): Promise<CartSkuView[]>;
}
