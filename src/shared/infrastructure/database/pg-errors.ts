/**
 * Duck-typed on the SQLSTATE `code` rather than `instanceof DatabaseError` so these survive driver
 * re-wraps and bundling.
 */

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

/**
 * Matched by constraint name because a table's several checks mean different things. Walks the
 * `cause` chain, unlike the unique helper above: Drizzle wraps the driver error for the statement
 * builders these writes use, so the SQLSTATE is not on the object thrown.
 */
export function isCheckViolation(error: unknown, constraintName: string): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth++) {
    if (typeof current === 'object') {
      const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
      if (e.code === '23514' && e.constraint === constraintName) {
        return true;
      }
      current = e.cause;
    } else {
      return false;
    }
  }
  return false;
}
