/**
 * Duck-typed on the SQLSTATE `code` rather than `instanceof DatabaseError` so these survive driver
 * re-wraps and bundling. Both walk the `cause` chain: Drizzle wraps the driver error for the
 * statement builders these writes use, so the SQLSTATE is not on the object thrown.
 */

export function isUniqueViolation(error: unknown, indexName?: string): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth++) {
    if (typeof current !== 'object') {
      return false;
    }
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    // `constraint` names the violated index; match it when known, but don't miss the violation on a
    // driver that leaves it unset.
    if (e.code === '23505' && (indexName === undefined || e.constraint === undefined || e.constraint === indexName)) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/** Matched by constraint name because a table's several checks mean different things. */
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
