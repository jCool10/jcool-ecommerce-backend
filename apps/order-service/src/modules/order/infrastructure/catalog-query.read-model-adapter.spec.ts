import { describe, expect, it, vi } from 'vitest';
import type { CatalogSkuView } from '../../catalog/application/public/catalog-sku-query.port';
import { CatalogQueryReadModelAdapter } from './catalog-query.read-model-adapter';

const view = (skuId: string, overrides: Partial<CatalogSkuView> = {}): CatalogSkuView => ({
  skuId,
  productName: `Product ${skuId}`,
  unitPriceMinor: 150_000,
  currency: 'VND',
  isActive: true,
  ...overrides,
});

describe('CatalogQueryReadModelAdapter', () => {
  it("reads every distinct id once and maps each view to Order's own shape", async () => {
    const getSkuViews = vi
      .fn()
      .mockResolvedValue([{ ...view('200', { unitPriceMinor: null, isActive: false }), productId: '9' }, view('100')]);
    const adapter = new CatalogQueryReadModelAdapter({ getSkuView: vi.fn(), getSkuViews });

    const views = await adapter.getSkuViews(['100', '200', '100']);

    expect(getSkuViews).toHaveBeenCalledExactlyOnceWith(['100', '200']);
    expect(new Map(views.map((v) => [v.skuId, v]))).toEqual(
      new Map([
        ['100', view('100')],
        ['200', view('200', { unitPriceMinor: null, isActive: false })],
      ]),
    );
  });

  it('costs no read for an empty list', async () => {
    const getSkuViews = vi.fn();
    const adapter = new CatalogQueryReadModelAdapter({ getSkuView: vi.fn(), getSkuViews });

    await expect(adapter.getSkuViews([])).resolves.toEqual([]);
    expect(getSkuViews).not.toHaveBeenCalled();
  });
});
