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
      // The store, the migration runner and the Nest wiring are covered by the e2e tier.
      exclude: [
        'src/**/*.spec.ts',
        'src/**/testing/**',
        'src/**/*.module.ts',
        'src/main.ts',
        'src/app.setup.ts',
        'src/health/health.controller.ts',
        'src/database/**',
        'src/lease/postgres-lease-store.ts',
      ],
      thresholds: { statements: 98, branches: 88, functions: 98, lines: 98 },
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
