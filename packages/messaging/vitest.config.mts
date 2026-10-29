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
      exclude: ['src/**/*.spec.ts', 'src/**/*.module.ts', 'src/testing/**', 'src/**/schema/**'],
      // Measured minus two on the unit tier alone; the module wiring and Redis clients are left to
      // the services' e2e suites.
      thresholds: { statements: 84, branches: 81, functions: 79, lines: 85 },
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
