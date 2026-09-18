/**
 * Implemented by the context that owns the table, because a retention rule is a statement about that
 * context's correctness — how long an idempotency key must survive to keep a retry safe.
 */
export interface RetentionSweep {
  /**
   * Stable identifier, `context:table` by convention (`auth-tokens:refresh`). Both the metric label
   * and the fault-isolation unit, so two tables never share one. Low cardinality by construction.
   */
  readonly name: string;

  /**
   * Delete at most `batchSize` rows this tick and return how many went; a full batch is the
   * scheduler's signal that the table is not keeping up.
   */
  sweep(batchSize: number): Promise<number>;
}
