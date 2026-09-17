import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineProject } from 'vitest/config';

// Transform is SWC, not Vitest's default esbuild: esbuild does NOT emit `emitDecoratorMetadata`,
// which NestJS DI needs. SWC with `decoratorMetadata: true` does, so Test.createTestingModule()
// works zero-plugin at the app layer.
export default defineProject({
  test: {
    name: 'checkout-core',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    alias: {
      // Real uuid v7 is timestamp+random; the deterministic double keeps unit runs reproducible
      // (exact values are never asserted). e2e uses the real one.
      uuid: fileURLToPath(new URL('./test/mocks/uuid.js', import.meta.url)),
      // Workspace packages from source, as the `@jcool/source` export condition does for tsc and tsx.
      // A key also matches every path under it, so a subpath goes before its package.
      '@jcool/identity/errors': fileURLToPath(
        new URL('../../packages/identity/src/identity.errors.ts', import.meta.url),
      ),
      '@jcool/identity': fileURLToPath(new URL('../../packages/identity/src/index.ts', import.meta.url)),
      '@jcool/kernel': fileURLToPath(new URL('../../packages/kernel/src/index.ts', import.meta.url)),
      // Duplicated from tsconfig paths because SWC/Vite do not read tsconfig.
      '@modules': fileURLToPath(new URL('./src/modules', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
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
