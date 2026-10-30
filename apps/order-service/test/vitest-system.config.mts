import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/system/**/*.system-spec.ts'],
    testTimeout: 180_000,
    // Builds six images on a cold cache.
    hookTimeout: 900_000,
    // One stack at a time: two would not fit a laptop, and the scenarios kill containers.
    fileParallelism: false,
  },
});
