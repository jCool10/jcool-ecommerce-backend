import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'identity',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    alias: {
      '@jcool/kernel': fileURLToPath(new URL('../kernel/src/index.ts', import.meta.url)),
    },
  },
  // The app project also runs this source, through SWC: two transforms of one file merge into skewed coverage.
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
