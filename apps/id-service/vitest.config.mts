import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC rather than esbuild: Nest DI in the specs needs `emitDecoratorMetadata`, which esbuild drops.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Workspace deps resolve outside node_modules; without this Vitest inlines their dist.
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // The store, the migration runner, the Nest wiring and the mint endpoint are covered by the e2e tier.
      exclude: [
        'src/**/*.spec.ts',
        'src/**/testing/**',
        'src/**/*.module.ts',
        'src/main.ts',
        'src/app.setup.ts',
        'src/health/health.controller.ts',
        'src/database/**',
        'src/lease/postgres-lease-store.ts',
        'src/mint/mint.controller.ts',
        'src/mint/lease-not-held.filter.ts',
        'src/mint/mint.request.ts',
        'src/mint/mint.metrics.ts',
      ],
      thresholds: { statements: 98, branches: 90, functions: 98, lines: 98 },
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
