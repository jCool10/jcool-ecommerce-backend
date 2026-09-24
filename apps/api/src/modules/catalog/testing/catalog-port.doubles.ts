import type { CatalogSearchPort, ProductRepositoryPort } from '../application/ports';

/**
 * Whole-port doubles for the product read port and the search port. Every method answers with an
 * empty value, so a spec overrides only what it exercises and still passes a real port, not a cast.
 */
export function fakeProductRepository(overrides: Partial<ProductRepositoryPort> = {}): ProductRepositoryPort {
  return {
    findManyActive: () => Promise.resolve({ items: [], total: 0 }),
    findActiveAfter: () => Promise.resolve([]),
    findActiveByIdOrSlug: () => Promise.resolve(null),
    findSkuView: () => Promise.resolve(null),
    findManySkuViews: () => Promise.resolve([]),
    ...overrides,
  };
}

export function fakeCatalogSearch(overrides: Partial<CatalogSearchPort> = {}): CatalogSearchPort {
  return {
    ensureIndex: () => Promise.resolve(),
    resetIndex: () => Promise.resolve(),
    bulkIndex: () => Promise.resolve(),
    indexProduct: () => Promise.resolve(),
    deleteProduct: () => Promise.resolve(),
    search: () => Promise.resolve({ items: [], total: 0 }),
    ...overrides,
  };
}
