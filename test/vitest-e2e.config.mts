import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// e2e config (HTTP via supertest + Testcontainers). Kept separate from the unit
// config so `test` stays fast and hermetic.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/**/*.e2e-spec.ts'],
    passWithNoTests: true,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://e2e:e2e@127.0.0.1:5432/e2e_import_time_placeholder',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_ACCESS_SECRET: '2b557f0c-ac0e-469d-bd24-9a380d07e3bc', // ≥32 chars for the schema
      // Deterministic so every app in a run buckets identically. Lives here and in
      // test-app.factory.ts only — never in .env.example, which is copied to real environments.
      IDENTITY_BUCKET_KEY: 'e2e-identity-bucket-key-not-a-real-secret-000',
    },
    // Path aliases (mirror tsconfig paths) for the e2e runner. Semantic aliases
    // first (`@modules`/`@shared`), `@` catch-all last.
    alias: {
      '@modules': fileURLToPath(new URL('../src/modules', import.meta.url)),
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
    // Boot Postgres + Redis containers once per run and migrate; connection URLs
    // reach tests via provide()/inject() (globalSetup runs in its own process).
    globalSetup: ['./test/setup/global-setup.ts'],
    // Testcontainers spins real Postgres/Redis — give containers room and avoid
    // cross-file races on shared ports.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
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
