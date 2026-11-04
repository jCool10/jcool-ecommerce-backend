import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Shared with test/vitest-e2e.config.mts: the merge keeps only files both runs admit.
export const coverageScope = {
  provider: 'v8' as const,
  include: ['src/**/*.ts'],
  exclude: [
    'src/**/*.spec.ts',
    'src/**/testing/**',
    // Wiring and declarations: no logic to measure.
    'src/**/*.module.ts',
    'src/main.ts',
    'src/instrumentation.ts',
    'src/**/index.ts',
    'src/**/schema/**',
    // Does its work at import as a child process, outside the measured workers.
    'src/lease/lift-floors-cli.ts',
  ],
};

// Applied only by test/vitest-coverage-merge.config.mts, over the merged unit and e2e maps.
export const mergedThresholds = { statements: 95, branches: 88, functions: 95, lines: 98 };

// SWC rather than esbuild: Nest DI in the specs needs `emitDecoratorMetadata`, which esbuild drops.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Workspace deps resolve outside node_modules; without this Vitest inlines their dist.
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    coverage: {
      ...coverageScope,
      reportsDirectory: './coverage/unit',
      // The etcd store, the endpoint and the Nest wiring are reached by the e2e tier; the strict floor
      // is the merged one. Measured minus two.
      thresholds: { statements: 46, branches: 41, functions: 35, lines: 48 },
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
