import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { E2E_BASE_ENV } from './setup/e2e-env.js';
import { workerCount } from './setup/worker-count.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/integration/**/*.e2e-spec.ts'],
    passWithNoTests: true,
    // Only has to pass validation when AppModule is imported; createTestApp sets the real values.
    env: {
      ...E2E_BASE_ENV,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://e2e:e2e@127.0.0.1:5432/e2e_import_time_placeholder',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_ES256_PRIVATE_KEYS: 'import-time-placeholder',
      DB_POOL_MAX: '10',
    },
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    globalSetup: ['./test/setup/global-setup.ts'],
    setupFiles: ['./test/setup/worker-resources.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    // Each worker is a process of its own, so createTestApp's process.env writes stay per worker.
    pool: 'forks',
    // Must match the databases globalSetup clones.
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
