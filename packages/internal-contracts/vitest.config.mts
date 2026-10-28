import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // The case table and its HTTP driver are exercised by each service's e2e, not here.
      exclude: ['src/**/*.spec.ts', 'src/index.ts', 'src/testing.ts', 'src/**/contract-cases.ts', 'src/**/http-contract-driver.ts'],
      // Measured minus two.
      thresholds: { statements: 98, branches: 98, functions: 98, lines: 98 },
    },
  },
});
