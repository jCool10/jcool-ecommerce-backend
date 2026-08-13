import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// e2e config (HTTP via supertest + Testcontainers). Kept separate from the unit
// config so `test` stays fast and hermetic. No `*.e2e-spec.ts` exist yet, so
// `passWithNoTests` keeps `npm run test:e2e` green until the first e2e lands.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['test/**/*.e2e-spec.ts'],
    passWithNoTests: true,
    // Path aliases (mirror tsconfig paths) for the e2e runner. Semantic aliases
    // first (`@modules`/`@shared`), `@` catch-all last.
    alias: {
      '@modules': fileURLToPath(new URL('../src/modules', import.meta.url)),
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
    // Boot Postgres + Redis containers once per run and migrate; connection URLs
    // reach tests via provide()/inject() (globalSetup runs in its own process).
    globalSetup: ['./test/setup/global-setup.ts'],
    // Testcontainers spins real Postgres/Redis — give containers room and avoid
    // cross-file races on shared ports.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
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
