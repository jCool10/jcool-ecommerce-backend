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
      // Repositories, controllers and the Nest wiring are covered by the e2e tier.
      exclude: [
        'src/**/*.spec.ts',
        'src/**/testing/**',
        'src/**/index.ts',
        'src/**/*.module.ts',
        'src/**/*.port.ts',
        'src/main.ts',
        'src/app.setup.ts',
        'src/database/**',
        'src/config/configuration.ts',
        'src/modules/inventory/infrastructure/**',
        'src/modules/inventory/interface/admin-inventory.controller.ts',
        'src/modules/inventory/interface/dto/**',
      ],
      // Glob-scoped, not global: adapters and guards lean on the e2e tier, which `test:cov` does not
      // run. Measured minus two.
      thresholds: {
        'src/**/{domain,application}/**': { statements: 95, branches: 95, functions: 98, lines: 95 },
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
