import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
      // Measured minus two. The fakes are exercised by every app's specs, not by this package's own.
      thresholds: { statements: 69, branches: 83, functions: 48, lines: 68 },
    },
  },
});
