/**
 * Postgres error helpers. Duck-typed on the SQLSTATE `code` rather than `instanceof DatabaseError`
 * so it survives driver re-wraps/bundling. Lets an adapter translate a DB constraint race into a
 * typed domain error instead of leaking a raw 500.
 */

/** SQLSTATE 23505 = unique_violation. */
export function isUniqueViolation(error: unknown, indexName?: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const e = error as { code?: string; constraint?: string };
  if (e.code !== '23505') {
    return false;
  }
  // `constraint` names the violated index; match it when known, but don't miss the violation on a
  // driver that leaves it unset.
  return indexName === undefined || e.constraint === undefined || e.constraint === indexName;
}
