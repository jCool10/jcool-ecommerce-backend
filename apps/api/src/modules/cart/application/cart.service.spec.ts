import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { CartItem } from '../domain/cart-item.entity';
import type { CartRepositoryPort } from './ports/cart-repository.port';
import type { CartSkuView } from './ports/catalog-query.port';
import { MAX_CART_LINES } from '../cart.constants';
import { CartService } from './cart.service';

const SKU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SKU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function skuView(overrides: Partial<CartSkuView> = {}): CartSkuView {
  return { skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, currency: 'VND', isActive: true, ...overrides };
}

function build(items: CartItem[], views: CartSkuView[]): CartService {
  const repo: CartRepositoryPort = {
    ensureCartId: () => Promise.resolve('cart-1'),
    findCartId: () => Promise.resolve('cart-1'),
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
  // Creating a cart mints an id, so a read must not depend on the id service being up.
  it('shows an empty cart to a user who has none without creating one', async () => {
    const ensureCartId = vi.fn().mockRejectedValue(new Error('id service unavailable'));
    const service = new CartService(
      {
        ensureCartId,
        findCartId: () => Promise.resolve(null),
        findItems: vi.fn(),
        addItem: vi.fn(),
        setItemQuantity: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
      { getSkuView: vi.fn(), getSkuViews: () => Promise.resolve([]) },
      fakeMetricsPort(),
    );

    await expect(service.view('u1')).resolves.toEqual({ items: [], subtotalMinor: 0, currency: 'VND' });
    expect(ensureCartId).not.toHaveBeenCalled();
  });

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

function writable(opts: { cartId?: string | null; items?: CartItem[]; sku?: CartSkuView | null }) {
  const repo = {
    ensureCartId: vi.fn().mockResolvedValue('cart-1'),
    findCartId: vi.fn().mockResolvedValue(opts.cartId === undefined ? 'cart-1' : opts.cartId),
    findItems: vi.fn().mockResolvedValue(opts.items ?? []),
    addItem: vi.fn(),
    setItemQuantity: vi.fn().mockResolvedValue(true),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  const catalog = {
    getSkuView: vi.fn().mockResolvedValue(opts.sku === undefined ? skuView() : opts.sku),
    getSkuViews: vi.fn().mockResolvedValue([]),
  };
  return { repo, service: new CartService(repo, catalog, fakeMetricsPort()) };
}

describe('CartService.addItem', () => {
  it('refuses a SKU that is not on sale as unknown', async () => {
    const { service, repo } = writable({ sku: skuView({ isActive: false }) });

    await expect(service.addItem('u1', SKU, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.addItem).not.toHaveBeenCalled();
  });

  it('refuses a new line past the cap but still accumulates onto an existing one', async () => {
    const full = Array.from({ length: MAX_CART_LINES }, (_, i) => CartItem.of(`sku-${i}`, 1));
    const { service, repo } = writable({ items: full });

    await expect(service.addItem('u1', SKU, 1)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.addItem).not.toHaveBeenCalled();

    await expect(service.addItem('u1', 'sku-3', 1).then(() => 'ok')).resolves.toBe('ok');
  });
});

describe('CartService writes on a user with no cart', () => {
  it('never creates one', async () => {
    const { service, repo } = writable({ cartId: null });

    await expect(service.setItemQuantity('u1', SKU, 2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.removeItem('u1', SKU)).resolves.toEqual({ items: [], subtotalMinor: 0, currency: 'VND' });
    await expect(service.clear('u1')).resolves.toEqual({ items: [], subtotalMinor: 0, currency: 'VND' });
    expect(repo.ensureCartId).not.toHaveBeenCalled();
  });
});
