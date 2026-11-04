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
    // Run in globalSetup or as a process of their own, outside the measured workers.
    'src/database/{schema,migrate}.ts',
    'src/database/*-cli.ts',
    'src/modules/order/infrastructure/temporal/bundle-checkout-saga-workflows.cli.ts',
    // Runs from a bundle inside Temporal's workflow sandbox, which v8 cannot map back to src (it reads 0%).
    // Replay histories and checkout-saga-workflow.e2e-spec.ts pin it.
    'src/modules/order/infrastructure/temporal/workflows/**',
  ],
};

// Applied only by test/vitest-coverage-merge.config.mts, over the merged unit and e2e maps.
export const mergedThresholds = {
  'src/**/infrastructure/**': { statements: 96, branches: 92, functions: 97, lines: 96 },
  'src/**/interface/**': { statements: 96, branches: 89, functions: 98, lines: 96 },
};

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
      // Unit floors cover domain/application; infrastructure and interface are floored on the merged
      // unit and e2e report (`test:e2e:cov`). Measured minus two.
      thresholds: {
        'src/**/{domain,application}/**': { statements: 93, branches: 90, functions: 89, lines: 93 },
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
