import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { CartItem } from '../domain/cart-item.entity';
import type { CartRepositoryPort } from './ports/cart-repository.port';
import type { CartSkuView } from './ports/catalog-query.port';
import { CartService } from './cart.service';

const SKU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SKU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function skuView(overrides: Partial<CartSkuView> = {}): CartSkuView {
  return { skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, currency: 'VND', isActive: true, ...overrides };
}

function build(items: CartItem[], views: CartSkuView[]): CartService {
  const repo: CartRepositoryPort = {
    ensureCartId: () => Promise.resolve('cart-1'),
    findItems: () => Promise.resolve(items),
    addItem: vi.fn(),
    setItemQuantity: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  const catalog = { getSkuView: vi.fn(), getSkuViews: () => Promise.resolve(views) };
  return new CartService(repo, catalog, fakeMetricsPort());
}

describe('CartService.view', () => {
  it('prices each line from its own SKU whatever order the batch read returns', async () => {
    const service = build(
      [CartItem.of(SKU, 1), CartItem.of(OTHER_SKU, 2)],
      [
        skuView({ skuId: OTHER_SKU, productName: 'Gadget', unitPriceMinor: 50_000 }),
        skuView({ productName: 'Widget', unitPriceMinor: 100_000 }),
      ],
    );

    const view = await service.view('u1');

    expect(view.items).toEqual([
      expect.objectContaining({ skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, lineTotalMinor: 100_000 }),
      expect.objectContaining({
        skuId: OTHER_SKU,
        productName: 'Gadget',
        unitPriceMinor: 50_000,
        lineTotalMinor: 100_000,
      }),
    ]);
    expect(view.subtotalMinor).toBe(200_000);
  });

  it('anchors the cart currency on the first priced line in cart order', async () => {
    const service = build(
      [CartItem.of(SKU, 1), CartItem.of(OTHER_SKU, 1)],
      [
        skuView({ skuId: OTHER_SKU, currency: 'USD', unitPriceMinor: 7 }),
        // Lower case on purpose: Money upper-cases its code, so an unnormalised anchor would drop this line.
        skuView({ currency: 'vnd', unitPriceMinor: 100_000 }),
      ],
    );

    const view = await service.view('u1');

    expect(view.currency).toBe('VND');
    // The USD line is still rendered, but Money forbids summing it into a VND subtotal.
    expect(view.subtotalMinor).toBe(100_000);
    expect(view.items[1]).toEqual(expect.objectContaining({ skuId: OTHER_SKU, unitPriceMinor: 7 }));
  });

  it('falls back to the default currency when no line is priced', async () => {
    const service = build([CartItem.of(SKU, 2)], [skuView({ unitPriceMinor: null, currency: 'USD' })]);

    const view = await service.view('u1');

    expect(view).toEqual({
      items: [expect.objectContaining({ skuId: SKU, unitPriceMinor: null, lineTotalMinor: null })],
      subtotalMinor: 0,
      currency: 'VND',
    });
  });
});
