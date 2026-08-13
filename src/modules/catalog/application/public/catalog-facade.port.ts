/** Catalog's published language — the only surface other bounded contexts may import (enforced by `.dependency-cruiser.cjs`); methods return plain DTO snapshots, never domain entities or rows. */
export const CATALOG_FACADE = Symbol('CATALOG_FACADE');

/** Minimal, stable projection of a published product for cross-context reads. */
export interface ProductSnapshot {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface CatalogFacade {
  /** A published (ACTIVE) product by id or slug; null if none. */
  getProductSnapshot(idOrSlug: string): Promise<ProductSnapshot | null>;
}
