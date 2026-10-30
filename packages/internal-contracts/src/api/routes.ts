export const API_INTERNAL_PREFIX = 'internal/v1';

export const apiReadRoutes = {
  cartLines: (userId: string) => `/${API_INTERNAL_PREFIX}/carts/${encodeURIComponent(userId)}/lines`,
  skuViews: `/${API_INTERNAL_PREFIX}/catalog/sku-views`,
};
