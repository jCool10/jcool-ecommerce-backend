import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { workerCount } from './setup/worker-count.js';

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
      // Placeholders for the import-time validation; createTestApp points both at the user-service
      // stub once its port is known.
      AUTH_JWKS_URL: 'http://127.0.0.1:1/.well-known/jwks.json',
      USER_SERVICE_INTERNAL_URL: 'http://127.0.0.1:1',
      INTERNAL_API_TOKEN: 'e2e-internal-api-token-not-a-real-secret-0',
      JWT_ISSUER: 'https://users.jcool.test',
      JWT_AUDIENCE: 'jcool-api',
      // Left at the production default. No spec holds more than two apps open at once
      // (`queue-connection.e2e-spec.ts`), so the real peak is 2 × 10 × 4 workers = 80 plus a handful
      // of raw pools, comfortably inside the container's max_connections=300. Capping it lower
      // starves the 12-16 contender races, which serialize on a stock row lock while each in-flight
      // request holds a pool client: once the queue outlives `DB_POOL_CONNECTION_TIMEOUT_MS`
      // (5000ms default, @jcool/platform database.config) the acquire throws and the request 500s, breaking the
      // "every non-winner answered a clean 409, none errored" assertions.
      DB_POOL_MAX: '10',
    },
    // Path aliases (mirror tsconfig paths) for the e2e runner. Semantic aliases
    // first (`@modules`/`@shared`), `@` catch-all last.
    alias: {
      '@modules': fileURLToPath(new URL('../src/modules', import.meta.url)),
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
    // Same reason as the unit config: one instance of every workspace package, the native one.
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    // Boot Postgres + Redis containers once per run and migrate; connection URLs
    // reach tests via provide()/inject() (globalSetup runs in its own process).
    globalSetup: ['./test/setup/global-setup.ts'],
    // Resolves this worker's database + Redis index before any spec module loads, and fails the
    // worker loudly if the pool grew past the databases globalSetup pre-created.
    setupFiles: ['./test/setup/worker-resources.ts'],
    // Testcontainers spins real Postgres/Redis: give containers room and avoid
    // cross-file races on shared ports.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Files run in parallel across worker processes, each against its own database and Redis logical
    // db (test/setup/worker-resources.ts). `forks` gives every worker its own process, which is also
    // what keeps the prom-client default registry and createTestApp's process.env writes per-worker.
    fileParallelism: true,
    // Pinned, not inherited from the Vitest default: the paragraph above is only true under `forks`.
    // Under `threads` the workers share one process, and with it `process.env` and the prom-client
    // default registry, which `createTestApp` writes to per file. That would not fail loudly; it
    // would make one file read another's config.
    pool: 'forks',
    // Must match the number of databases globalSetup creates. Both go through `workerCount()` so a
    // malformed E2E_WORKERS throws here rather than resolving to NaN, which Vitest reads as "unset"
    // and answers with one worker per CPU, every worker past the pre-created range then dying on a
    // database nobody cloned.
    maxWorkers: workerCount(),
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
