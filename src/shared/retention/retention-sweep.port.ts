/**
 * One table's reclamation rule, callable by the scheduler without knowing what it deletes.
 *
 * Each context implements this for the tables it owns, because a retention rule is a statement about
 * that context's correctness — how long an idempotency key must survive to keep a retry safe, how
 * long a revoked refresh token must survive to stay a theft signal.
 */
export interface RetentionSweep {
  /**
   * Stable identifier, `context:table` by convention (`auth-tokens:refresh`). Both the metric label
   * and the fault-isolation unit, so two tables never share one. Low cardinality by construction.
   */
  readonly name: string;

  /**
   * Delete at most `batchSize` rows this tick and return how many went; the rest wait for the next
   * tick. A full batch is the scheduler's signal that the table is not keeping up.
   */
  sweep(batchSize: number): Promise<number>;
}
