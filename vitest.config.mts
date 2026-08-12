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
      // cuid2 v3 is ESM-only. The deterministic test double keeps generated ids
      // stable within a run (their exact format is never asserted). Mirrors the
      // former Jest `moduleNameMapper` entry.
      '@paralleldrive/cuid2': fileURLToPath(
        new URL('./test/mocks/cuid2.js', import.meta.url),
      ),
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
