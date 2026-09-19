import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Real images on a Docker network: nothing from src/ is loaded in-process.
export default defineConfig({
  test: {
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/system/**/*.system-spec.ts'],
    server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
    testTimeout: 180_000,
    // Builds the api, user-service, id-service and gateway images on a cold cache.
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
