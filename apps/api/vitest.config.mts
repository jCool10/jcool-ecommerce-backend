import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Shared with test/vitest-e2e.config.mts: the merge keeps only files both runs admit.
export const coverageScope = {
  provider: 'v8' as const,
  include: ['src/**/*.ts'],
  exclude: [
    'src/**/*.spec.ts',
    // Test doubles run in every spec that imports them; counting them inflates coverage.
    'src/**/testing/**',
    // Wiring and declarations: no logic to measure.
    'src/**/*.module.ts',
    'src/main.ts',
    'src/instrumentation.ts',
    'src/**/index.ts',
    'src/**/schema/**',
    // Run in globalSetup or as a process of their own, outside the measured workers.
    'src/shared/infrastructure/database/{migrate,migrate-cli,seed}.ts',
    'src/shared/infrastructure/storage/verify-storage-orphans.cli.ts',
  ],
};

// Applied only by test/vitest-coverage-merge.config.mts, over the merged unit and e2e maps.
export const mergedThresholds = {
  'src/**/infrastructure/**': { statements: 85, branches: 79, functions: 91, lines: 85 },
  'src/**/interface/**': { statements: 92, branches: 80, functions: 93, lines: 94 },
};

// Transform is SWC, not Vitest's default esbuild: esbuild does NOT emit `emitDecoratorMetadata`,
// which NestJS DI needs. SWC with `decoratorMetadata: true` does, so Test.createTestingModule()
// works zero-plugin at the app layer.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // AppModule validates env when it is imported, and a spec that imports it must not depend on
    // whatever a developer's .env happens to hold. Placeholders: nothing here opens a connection.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:5432/unit',
      REDIS_URL: 'redis://127.0.0.1:6379',
      AUTH_JWKS_URL: 'http://127.0.0.1:1/.well-known/jwks.json',
      JWT_ISSUER: 'https://users.jcool.test',
      JWT_AUDIENCE: 'jcool-api',
      USER_SERVICE_INTERNAL_URL: 'http://127.0.0.1:1',
      INTERNAL_API_TOKEN: 'unit-internal-api-token-not-a-real-secret',
      ID_SERVICE_URL: 'http://127.0.0.1:1',
    },
    // Workspace packages resolve outside node_modules, so Vitest would inline their dist and mint a
    // second copy of a token such as METRICS next to the one natively loaded packages hold.
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    alias: {
      // Duplicated from tsconfig paths because SWC/Vite do not read tsconfig.
      '@modules': fileURLToPath(new URL('./src/modules', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    coverage: {
      ...coverageScope,
      reportsDirectory: './coverage/unit',
      // Unit floors cover domain/application; infrastructure and interface are floored on the merged
      // unit and e2e report (`test:e2e:cov`). Measured minus two.
      thresholds: {
        'src/**/{domain,application}/**': {
          statements: 75,
          branches: 72,
          functions: 78,
          lines: 76,
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
