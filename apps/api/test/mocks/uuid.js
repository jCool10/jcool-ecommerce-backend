/**
 * Test double for the `uuid` package's `v7()`, wired via Vitest `test.alias`
 * (see `vitest.config.mts`).
 *
 * Unit tests only need `v7()` to return a unique, non-empty id — the exact value
 * is never asserted — so a monotonic counter is sufficient and keeps id
 * generation deterministic across a run (reproducible tests). The real generator
 * is non-deterministic (timestamp + random), so the double is kept on purpose.
 *
 * Emits a well-formed UUID v7 string (version nibble `7`, RFC 9562 variant `8`)
 * so any format-sensitive path (e.g. class-validator `@IsUUID`) stays valid.
 */
let counter = 0;

function v7() {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, '0');
  return `00000000-0000-7000-8000-${suffix}`;
}

module.exports = { v7 };
