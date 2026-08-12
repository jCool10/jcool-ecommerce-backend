/**
 * Test double for `@paralleldrive/cuid2`, wired via Vitest `test.alias`
 * (see `vitest.config.ts`).
 *
 * Unit tests only need `createId()` to return a unique, non-empty opaque string
 * — the exact cuid2 format is never asserted — so a monotonic counter is
 * sufficient and keeps id generation deterministic across a run (reproducible
 * tests). Vitest is ESM-native so it could import real cuid2 v3, but the real
 * generator is non-deterministic; the double is kept on purpose.
 */
let counter = 0;

function createId() {
  counter += 1;
  return `test-cuid-${counter.toString(36).padStart(8, '0')}`;
}

module.exports = { createId };
