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
