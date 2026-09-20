import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

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
    },
    // Workspace packages resolve outside node_modules, so Vitest would inline their dist and mint a
    // second copy of a token such as METRICS next to the one natively loaded packages hold.
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    alias: {
      // Real uuid v7 is timestamp+random; the deterministic double keeps unit runs reproducible
      // (exact values are never asserted). e2e uses the real one.
      uuid: fileURLToPath(new URL('./test/mocks/uuid.js', import.meta.url)),
      // Duplicated from tsconfig paths because SWC/Vite do not read tsconfig.
      '@modules': fileURLToPath(new URL('./src/modules', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // `testing/` holds test doubles: they run in every spec that imports them, so counting them
      // would inflate coverage with lines no production path executes.
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.module.ts',
        'src/main.ts',
        'src/modules/*/testing/**',
      ],
      // Glob-scoped, not global: `test:cov` runs the unit tier only, and repositories, adapters and
      // controllers are covered by the e2e tier — a global floor would go red on code that is tested.
      // The numbers are measured-minus-two, not a round 80 that would sit far below or above reality.
      // Re-measured after the user context moved out; the ratio barely moved.
      thresholds: {
        'src/**/{domain,application}/**': {
          statements: 84,
          branches: 80,
          functions: 84,
          lines: 84,
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
