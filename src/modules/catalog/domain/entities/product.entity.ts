import { Money } from '@shared/kernel';

// Pure domain — no framework/DB imports.

// Mirrors the Drizzle `product_status` pgEnum.
export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  prices: Money[];
}

export interface ProductCategory {
  slug: string;
  name: string;
}

export class Product {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly slug: string,
    public readonly description: string | null,
    public readonly status: ProductStatus,
    public readonly category: ProductCategory,
    public readonly variants: ProductVariant[],
    public readonly createdAt: Date,
    /**
     * In display order, ids only, never URLs: a resolved URL can expire, and ids are what let this
     * aggregate be cached safely.
     */
    public readonly imageAssetIds: string[] = [],
  ) {}
}
