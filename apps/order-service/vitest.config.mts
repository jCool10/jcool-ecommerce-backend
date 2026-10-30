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
      // Repositories, controllers, the workflow sandbox and the Nest wiring are covered by the e2e tier.
      exclude: [
        'src/**/*.spec.ts',
        'src/**/testing/**',
        'src/**/index.ts',
        'src/**/*.module.ts',
        'src/**/*.port.ts',
        'src/main.ts',
        'src/app.setup.ts',
        'src/instrumentation.ts',
        'src/database/**',
        'src/config/configuration.ts',
        'src/shared/messaging/replay-dlq.cli.ts',
        'src/modules/order/infrastructure/drizzle-*.repository.ts',
        'src/modules/order/infrastructure/schema/**',
        'src/modules/order/infrastructure/temporal/bundle-checkout-saga-workflows.cli.ts',
        'src/modules/order/interface/**/*.controller.ts',
        'src/modules/order/interface/dto/**',
      ],
      // Glob-scoped, not global: adapters and guards lean on the e2e tier, which `test:cov` does not
      // run. Measured minus two.
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
