import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { CartItem } from '../domain/cart-item.entity';
import type { CartRepositoryPort } from './ports/cart-repository.port';
import type { CartSkuView, CatalogQueryPort } from './ports/catalog-query.port';
import { CartService } from './cart.service';

const SKU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SKU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function skuView(overrides: Partial<CartSkuView> = {}): CartSkuView {
  return { skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, currency: 'VND', isActive: true, ...overrides };
}

function build(opts: { items?: CartItem[]; views?: CartSkuView[] } = {}) {
  const items = opts.items ?? [CartItem.of(SKU, 1)];
  const getSkuViews = vi.fn().mockResolvedValue(opts.views ?? [skuView()]);
  const repo = {
    ensureCartId: vi.fn().mockResolvedValue('cart-1'),
    findItems: vi.fn().mockResolvedValue(items),
  } as unknown as CartRepositoryPort;
  const catalog = { getSkuView: vi.fn(), getSkuViews } as CatalogQueryPort;
  const metrics = { recordCartOperation: vi.fn() } as unknown as MetricsPort;

  return { service: new CartService(repo, catalog, metrics), getSkuViews };
}

describe('CartService.view', () => {
  it('reads every line from Catalog in one batch call', async () => {
    const { service, getSkuViews } = build({
      items: [CartItem.of(SKU, 1), CartItem.of(OTHER_SKU, 2)],
      views: [skuView(), skuView({ skuId: OTHER_SKU })],
    });

    await service.view('u1');

    expect(getSkuViews).toHaveBeenCalledTimes(1);
    expect(getSkuViews).toHaveBeenCalledWith([SKU, OTHER_SKU]);
  });

  it('prices each line from its own SKU, whatever order the batch read came back in', async () => {
    const { service } = build({
      items: [CartItem.of(SKU, 1), CartItem.of(OTHER_SKU, 2)],
      views: [
        skuView({ skuId: OTHER_SKU, productName: 'Gadget', unitPriceMinor: 50_000 }),
        skuView({ productName: 'Widget', unitPriceMinor: 100_000 }),
      ],
    });

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

  it('anchors the cart currency on the first priced line in cart order, not in batch order', async () => {
    const { service } = build({
      items: [CartItem.of(SKU, 1), CartItem.of(OTHER_SKU, 1)],
      views: [
        skuView({ skuId: OTHER_SKU, currency: 'USD', unitPriceMinor: 7 }),
        skuView({ currency: 'VND', unitPriceMinor: 100_000 }),
      ],
    });

    const view = await service.view('u1');

    expect(view.currency).toBe('VND');
    // The USD line is still rendered, but Money forbids summing it into a VND subtotal.
    expect(view.subtotalMinor).toBe(100_000);
    expect(view.items[1]).toEqual(expect.objectContaining({ skuId: OTHER_SKU, unitPriceMinor: 7 }));
  });

  it('renders a line whose SKU left Catalog without shifting the lines after it', async () => {
    const { service } = build({
      items: [CartItem.of(SKU, 1), CartItem.of(OTHER_SKU, 2)],
      views: [skuView({ skuId: OTHER_SKU, productName: 'Gadget', unitPriceMinor: 50_000 })],
    });

    const view = await service.view('u1');

    expect(view.items[0]).toEqual({
      skuId: SKU,
      productName: '',
      quantity: 1,
      unitPriceMinor: null,
      lineTotalMinor: null,
      isActive: false,
    });
    expect(view.items[1]).toEqual(expect.objectContaining({ skuId: OTHER_SKU, productName: 'Gadget' }));
    expect(view.subtotalMinor).toBe(100_000);
  });

  it('falls back to the default currency when no line is priced', async () => {
    const { service, getSkuViews } = build({ items: [], views: [] });

    const view = await service.view('u1');

    expect(view).toEqual({ items: [], subtotalMinor: 0, currency: 'VND' });
    expect(getSkuViews).toHaveBeenCalledWith([]);
  });
});
