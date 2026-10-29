import { fileURLToPath } from 'node:url';
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
    // A counter in place of uuid v7, so unit runs mint the same ids every time. e2e uses the real one.
    alias: { uuid: fileURLToPath(new URL('./test/mocks/uuid.js', import.meta.url)) },
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
        'src/instrumentation.ts',
        'src/database/**',
        'src/config/configuration.ts',
        'src/modules/payment/infrastructure/*.repository.ts',
        'src/modules/payment/infrastructure/schema/**',
        'src/modules/payment/interface/**/dto/**',
      ],
      // Glob-scoped, not global: adapters and guards lean on the e2e tier, which `test:cov` does not
      // run. Measured minus two.
      thresholds: {
        'src/**/{domain,application}/**': { statements: 90, branches: 87, functions: 92, lines: 92 },
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
