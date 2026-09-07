import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit-test config. Runner: Vitest (ADR 0011). Transform: SWC — Vitest's default
// esbuild does NOT emit `emitDecoratorMetadata`, which NestJS DI needs; SWC with
// `decoratorMetadata: true` does, so Test.createTestingModule() works zero-plugin
// at the app layer.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    alias: {
      // The deterministic test double keeps generated ids stable within a run
      // (their exact value is never asserted). Real uuid v7 is timestamp+random,
      // so it is aliased out for reproducible unit tests; e2e uses the real one.
      uuid: fileURLToPath(new URL('./test/mocks/uuid.js', import.meta.url)),
      // Path aliases (mirror tsconfig paths). SWC/Vite don't read tsconfig, so
      // resolution is declared here for the test runner. Semantic aliases first
      // (`@modules`/`@shared`), `@` catch-all last; prefixes are disjoint by
      // rollup-alias word-boundary matching so order is cosmetic.
      '@modules': fileURLToPath(new URL('./src/modules', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.module.ts', 'src/main.ts'],
      // Gated by glob, not globally. `test:cov` runs the unit tier only, and repositories,
      // adapters and controllers are covered by the e2e tier instead — a global floor would
      // therefore fail on code that is in fact tested, and the usual fix for that is to lower
      // the floor until it means nothing. Domain and application are where unit tests actually
      // live, so that is where the floor is enforced.
      //
      // The numbers are the measured values minus two points, not a round 80: a floor picked for
      // looking tidy either sits far below reality (and catches nothing) or above it (and is
      // switched off the first time it goes red).
      thresholds: {
        'src/**/{domain,application}/**': {
          statements: 84,
          branches: 79,
          functions: 85,
          lines: 85,
        },
      },
    },
  },
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
      module: { type: 'es6' },
    }),
  ],
});
