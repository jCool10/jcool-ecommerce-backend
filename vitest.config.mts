import { defineConfig } from 'vitest/config';

// Coverage is a root-only option under `projects`, so the floor lives here rather than in each app.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
      // `testing/` holds test doubles: they run in every spec that imports them, so counting them
      // would inflate coverage with lines no production path executes.
      exclude: [
        'apps/*/src/**/*.spec.ts',
        'packages/*/src/**/*.spec.ts',
        'apps/*/src/**/*.module.ts',
        'apps/*/src/main.ts',
        'apps/*/src/shared/testing/**',
        'apps/*/src/modules/*/testing/**',
      ],
      // Glob-scoped, not global: `test:cov` runs the unit tier only, and repositories, adapters and
      // controllers are covered by the e2e tier — a global floor would go red on code that is tested.
      // The numbers are measured-minus-two, not a round 80 that would sit far below or above reality.
      thresholds: {
        'apps/*/src/**/{domain,application}/**': {
          statements: 84,
          branches: 79,
          functions: 85,
          lines: 85,
        },
      },
    },
  },
});
