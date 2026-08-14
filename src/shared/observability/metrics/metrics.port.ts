// Application-facing metrics seam. This file is PURE (no prom-client / framework import) so
// application code may depend on it without pulling infrastructure — the prom-client
// implementation lives in business.metrics.ts, wired via DI. Mirrors the auth-audit
// port/adapter split; keeps `npm run arch:check` green (ADR-0014).

export const METRICS = Symbol('METRICS');

/** Cart write operations, mirroring CartService's methods (low-cardinality label). */
export type CartOperation = 'add' | 'update' | 'remove' | 'clear';

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
}
