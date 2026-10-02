// Published to other contexts (per `.dependency-cruiser.cjs`); returns a plain snapshot, never a
// domain entity or a row.
export const PRODUCT_SKU_QUERY = Symbol('PRODUCT_SKU_QUERY');

export interface SkuView {
  /** The product-variant id — the stable SKU identity stock and Cart reference. */
  skuId: string;
  productName: string;
  /** Integer smallest-unit amount for `currency`; null when the SKU has no price. */
  unitPriceMinor: number | null;
  currency: string;
  /** True only when the product is ACTIVE and the variant is not archived. */
  isActive: boolean;
}

export interface ProductSkuQuery {
  getSkuView(skuId: string): Promise<SkuView | null>;

  /**
   * An id with no variant is absent from the result rather than null-filled, and the order is the
   * database's — key the result by `skuId`, never by position.
   */
  getSkuViews(skuIds: string[]): Promise<SkuView[]>;
}
