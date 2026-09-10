import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.aliases.mjs';

// Transform is SWC, not Vitest's default esbuild: esbuild does NOT emit `emitDecoratorMetadata`,
// which NestJS DI needs. SWC with `decoratorMetadata: true` does, so Test.createTestingModule()
// works zero-plugin at the app layer.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
    alias: {
      // Real uuid v7 is timestamp+random; the deterministic double keeps unit runs reproducible
      // (exact values are never asserted). e2e uses the real one.
      uuid: fileURLToPath(new URL('./test/mocks/uuid.js', import.meta.url)),
      // Duplicated from tsconfig paths because SWC/Vite do not read tsconfig.
      ...workspaceAliases(new URL('./', import.meta.url)),
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['apps/**/*.ts', 'libs/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/*.module.ts', 'apps/*/src/main.ts'],
      // Glob-scoped, not global: `test:cov` runs the unit tier only, and repositories, adapters and
      // controllers are covered by the e2e tier — a global floor would go red on code that is tested.
      // The numbers are measured-minus-two, not a round 80 that would sit far below or above reality.
      thresholds: {
        'apps/**/{domain,application}/**': {
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
