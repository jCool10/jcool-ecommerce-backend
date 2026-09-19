import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/**/*.system-spec.ts'],
    testTimeout: 60_000,
    // Builds the gateway and api images on a cold cache.
    hookTimeout: 900_000,
    // The load balancer suite asserts latency bounds that a second stack would eat into.
    fileParallelism: false,
  },
});
