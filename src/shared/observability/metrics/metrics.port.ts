// Application-facing metrics seam. Pure (no prom-client/framework import) so application code
// can depend on it without pulling infrastructure; the implementation is business.metrics.ts. ADR-0014.

export const METRICS = Symbol('METRICS');

/** Cart write operations, mirroring CartService's methods (low-cardinality label). */
export type CartOperation = 'add' | 'update' | 'remove' | 'clear';

/** Outcome of one cache lookup. `error` is Redis being unreachable — a served-from-source read that is not a cold miss, and the signal that the cache is down. */
export type CacheResult = 'hit' | 'miss' | 'error';

/**
 * Business events worth counting. Callers pass only bounded, low-cardinality values —
 * never an id/email/sku (those belong on logs/spans, not Prometheus labels).
 */
export interface MetricsPort {
  /** An order moved DRAFT → PENDING. `status` is the resulting order status (enum, bounded). */
  recordOrderCreated(status: string): void;
  /** Placed-order value in minor currency units (for the value distribution histogram). */
  observeOrderValue(amountMinor: number): void;
  /** A cart mutation succeeded. */
  recordCartOperation(op: CartOperation): void;
  /** A security-relevant auth event fired (`event` is the bounded AuthAuditEvent union). */
  recordAuthEvent(event: string, outcome: 'success' | 'failure'): void;
  /** One Catalog cache-aside lookup resolved. */
  recordCatalogCacheOperation(result: CacheResult): void;
}
