import { cartLinesOf, isCartLinesResponse, isSkuViewsResponse, skuViewsOf } from './guards';
import { apiReadRoutes } from './routes';

const LINE = { skuId: '11', quantity: 2 };
const VIEW = { skuId: '11', productName: 'Tee', unitPriceMinor: 150_000, currency: 'VND', isActive: true };

describe('api read guards', () => {
  it('accepts cart lines, an empty cart included', () => {
    expect(isCartLinesResponse({ lines: [LINE, { skuId: '12', quantity: 1 }] })).toBe(true);
    expect(isCartLinesResponse({ lines: [] })).toBe(true);
  });

  it.each([
    { lines: [{ ...LINE, skuId: '' }] },
    { lines: [{ ...LINE, skuId: 11 }] },
    { lines: [{ ...LINE, quantity: 0 }] },
    { lines: [{ ...LINE, quantity: 1.5 }] },
    { lines: [{ skuId: '11' }] },
    { lines: null },
    { lines: {} },
    [],
    null,
  ])('refuses %j as cart lines', (body) => {
    expect(isCartLinesResponse(body)).toBe(false);
  });

  it('accepts a view with no price, and an inactive one', () => {
    expect(isSkuViewsResponse({ views: [VIEW, { ...VIEW, unitPriceMinor: null, isActive: false }] })).toBe(true);
    expect(isSkuViewsResponse({ views: [] })).toBe(true);
  });

  it.each([
    { views: [{ ...VIEW, skuId: '' }] },
    { views: [{ ...VIEW, productName: null }] },
    { views: [{ ...VIEW, unitPriceMinor: -1 }] },
    { views: [{ ...VIEW, unitPriceMinor: 1.5 }] },
    { views: [{ ...VIEW, unitPriceMinor: '150000' }] },
    { views: [{ ...VIEW, unitPriceMinor: undefined }] },
    { views: [{ ...VIEW, currency: '' }] },
    { views: [{ ...VIEW, isActive: 'true' }] },
    { views: null },
    null,
  ])('refuses %j as SKU views', (body) => {
    expect(isSkuViewsResponse(body)).toBe(false);
  });

  it('maps only a 200 of the right shape, cut down to the contract fields', () => {
    expect(cartLinesOf(200, { lines: [{ ...LINE, priceMinor: 9 }], cartId: '1' })).toEqual([LINE]);
    expect(skuViewsOf(200, { views: [{ ...VIEW, stock: 3 }] })).toEqual([VIEW]);
    expect(cartLinesOf(201, { lines: [LINE] })).toBeUndefined();
    expect(cartLinesOf(404, { lines: [] })).toBeUndefined();
    expect(skuViewsOf(201, { views: [VIEW] })).toBeUndefined();
    expect(skuViewsOf(200, { message: 'Not Found' })).toBeUndefined();
  });

  it('escapes the user id into the cart path', () => {
    expect(apiReadRoutes.cartLines('7')).toBe('/internal/v1/carts/7/lines');
    expect(apiReadRoutes.cartLines('a/b')).toBe('/internal/v1/carts/a%2Fb/lines');
    expect(apiReadRoutes.skuViews).toBe('/internal/v1/catalog/sku-views');
  });
});
