/** Ids per `sku-views` read. A cart has no line limit, so the caller pages. */
export const MAX_SKU_VIEW_BATCH = 100;

export interface CartLineBody {
  skuId: string;
  quantity: number;
}

export interface CartLinesResponse {
  /** In the order they were added; empty when the user has no cart, never a 404. */
  lines: CartLineBody[];
}

export interface SkuViewsBody {
  /** 1 to MAX_SKU_VIEW_BATCH snowflake ids. */
  skuIds: string[];
}

export interface SkuViewBody {
  skuId: string;
  productName: string;
  /** Integer minor units; null while the SKU has no price. */
  unitPriceMinor: number | null;
  currency: string;
  /** False once the product is not ACTIVE or the variant is archived; the price stays. */
  isActive: boolean;
}

export interface SkuViewsResponse {
  /** An id the catalog does not know is left out; the order is the catalog's. */
  views: SkuViewBody[];
}
