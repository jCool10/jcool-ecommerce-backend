import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/**/*.system-spec.ts'],
    testTimeout: 60_000,
    // The first run builds the Caddy image.
    hookTimeout: 300_000,
  },
});
