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
        'src/modules/user/infrastructure/drizzle-*.repository.ts',
        'src/modules/user/infrastructure/schema/**',
        'src/modules/user/interface/**/*.controller.ts',
        'src/modules/user/interface/session-epoch-reconcile.scheduler.ts',
        'src/modules/user/interface/dto/**',
      ],
      // Measured minus two.
      thresholds: { statements: 96, branches: 94, functions: 93, lines: 97 },
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
