import type { CatalogSearchPort, ProductRepositoryPort, ProductSearchStatePort } from '../application/ports';

/**
 * Whole-port doubles for the product read, search state and search ports. Every method answers with
 * an empty value, so a spec overrides only what it exercises and still passes a real port, not a cast.
 */
export function fakeProductRepository(overrides: Partial<ProductRepositoryPort> = {}): ProductRepositoryPort {
  return {
    findManyActive: () => Promise.resolve({ items: [], total: 0 }),
    findActiveByIdOrSlug: () => Promise.resolve(null),
    findSkuView: () => Promise.resolve(null),
    findManySkuViews: () => Promise.resolve([]),
    ...overrides,
  };
}

export function fakeProductSearchState(overrides: Partial<ProductSearchStatePort> = {}): ProductSearchStatePort {
  return {
    findByIds: () => Promise.resolve([]),
    findAfter: () => Promise.resolve([]),
    bumpCategoryProducts: () => Promise.resolve([]),
    ...overrides,
  };
}

export function fakeCatalogSearch(overrides: Partial<CatalogSearchPort> = {}): CatalogSearchPort {
  return {
    ensureIndex: () => Promise.resolve(),
    write: () => Promise.resolve(),
    search: () => Promise.resolve({ items: [], total: 0 }),
    beginRebuild: () => Promise.resolve('products_v1'),
    writeRebuild: () => Promise.resolve(),
    promoteRebuild: () => Promise.resolve([]),
    abortRebuild: () => Promise.resolve(),
    dropRetired: () => Promise.resolve(),
    ...overrides,
  };
}
