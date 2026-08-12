/**
 * Test double for `@paralleldrive/cuid2`, wired via jest `moduleNameMapper`.
 *
 * cuid2 v3 ships ESM-only, and ts-jest does not transpile `node_modules`, so a
 * spec that transitively imports it (schemas, AuthTokensService, …) otherwise
 * fails with "Cannot use import statement outside a module". Unit tests only
 * need `createId()` to return a unique, non-empty opaque string — the exact
 * cuid2 format is never asserted — so a monotonic counter is sufficient and
 * keeps id generation deterministic across a run.
 */
let counter = 0;

function createId() {
  counter += 1;
  return `test-cuid-${counter.toString(36).padStart(8, '0')}`;
}

module.exports = { createId };
