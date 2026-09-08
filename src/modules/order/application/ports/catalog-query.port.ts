// Anti-corruption boundary: Order never imports Catalog's domain/infrastructure. Resolved live at
// order-creation time so price/name are snapshotted into the order.
export const CATALOG_QUERY = Symbol('ORDER_CATALOG_QUERY');

export interface OrderSkuView {
  skuId: string;
  productName: string;
  /** Integer smallest-unit price; null when the SKU has no price (not purchasable). */
  unitPriceMinor: number | null;
  currency: string;
  isActive: boolean;
}

export interface CatalogQueryPort {
  /**
   * An id Catalog does not know is absent from the result, and the order is Catalog's — key the
   * result by `skuId`, never by position.
   */
  getSkuViews(skuIds: string[]): Promise<OrderSkuView[]>;
}
