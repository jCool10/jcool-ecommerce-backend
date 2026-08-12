/**
 * Catalog's published language — the ONLY surface other bounded contexts may
 * import (enforced by `.dependency-cruiser.cjs`: cross-context imports are
 * restricted to `application/public/**`; domain / infrastructure / schema are
 * internal). Methods return plain DTO snapshots, never domain entities or rows.
 *
 * Contract only. The implementation + `CatalogModule` provider/export land with
 * the first real consumer (e.g. Order reading a product at checkout) — YAGNI
 * until then, so no speculative method is added here beyond the existing
 * public-read capability projected as a snapshot.
 */
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
