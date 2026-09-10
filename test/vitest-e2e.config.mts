import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../vitest.aliases.mjs';

// One throwaway ES256 pair per run, minted here rather than committed: env validation runs at
// import time, so the keys must exist before any spec file loads. Mirrored in test-app.factory.ts.
const jwtKeys = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

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
      // The user app's env validation also runs at import time, and it requires its own URL.
      USER_DATABASE_URL: 'postgresql://e2e:e2e@127.0.0.1:5432/e2e_import_time_placeholder',
      IDENTITY_LEASE_DATABASE_URL: 'postgresql://e2e:e2e@127.0.0.1:5432/e2e_import_time_placeholder',
      IDENTITY_LEASE_SERVICE: 'user',
      // Short so a suite asserting expiry does not wait 30s; still far above any statement here.
      IDENTITY_LEASE_TTL_SECONDS: '6',
      IDENTITY_LEASE_SKEW_MS: '1000',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_ES256_PRIVATE_KEY: jwtKeys.privateKey,
      JWT_ES256_PUBLIC_KEY: jwtKeys.publicKey,
      // Deterministic so every app in a run buckets identically; mirrored in test-app.factory.ts.
      IDENTITY_BUCKET_KEY: 'e2e-identity-bucket-key-not-a-real-secret-000',
    },
    // Path aliases (mirror tsconfig paths) for the e2e runner; shared with the unit config so the
    // two tiers cannot resolve the same specifier differently.
    alias: workspaceAliases(new URL('../', import.meta.url)),
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
