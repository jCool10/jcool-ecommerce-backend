import type { INestApplication } from '@nestjs/common';
import { apiInternalStub } from '../api-internal-stub';

// The catalog is the api's, so these arrange it on the worker's stub. The unused app argument keeps
// every caller unchanged.

export interface TestProductOptions {
  /** Anything but ACTIVE reads inactive. */
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  /** Integer minor units; null leaves the SKU unpriced. */
  priceMinor?: number | null;
  currency?: string;
  name?: string;
}

export interface TestProduct {
  productId: string;
  name: string;
  variantId: string;
  priceMinor: number | null;
}

export async function createTestProduct(
  _app: INestApplication,
  options: TestProductOptions = {},
): Promise<TestProduct> {
  const sku = (await apiInternalStub()).seedSku({
    productName: options.name,
    unitPriceMinor: options.priceMinor === undefined ? 199_000 : options.priceMinor,
    currency: options.currency,
    isActive: (options.status ?? 'ACTIVE') === 'ACTIVE',
  });
  return { productId: sku.productId, name: sku.productName, variantId: sku.skuId, priceMinor: sku.unitPriceMinor };
}

export async function archiveProduct(_app: INestApplication, productId: string): Promise<void> {
  (await apiInternalStub()).archiveProduct(productId);
}

export async function repriceSku(_app: INestApplication, variantId: string, amountMinor: number | null): Promise<void> {
  (await apiInternalStub()).updateSku(variantId, { unitPriceMinor: amountMinor });
}
