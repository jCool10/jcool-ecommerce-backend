/**
 * A Catalog surface other bounded contexts may import (this folder is the boundary
 * `.dependency-cruiser.cjs` enforces); methods return plain DTO snapshots, never domain entities or rows.
 */
export const CATALOG_FACADE = Symbol('CATALOG_FACADE');

export interface ProductSnapshot {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface CatalogFacade {
  /** Published (ACTIVE) products only. */
  getProductSnapshot(idOrSlug: string): Promise<ProductSnapshot | null>;
}
