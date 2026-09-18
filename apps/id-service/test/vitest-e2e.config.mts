import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/integration/**/*.e2e-spec.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      // Import-time placeholder for env validation; each app points at its own cloned database.
      DATABASE_URL: 'postgresql://e2e:e2e@127.0.0.1:5432/e2e_import_time_placeholder',
      SHUTDOWN_GRACE_PERIOD_MS: '0',
    },
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    globalSetup: ['./test/setup/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One process per file keeps process.env and the prom-client default registry per file.
    pool: 'forks',
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
