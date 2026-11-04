import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import unit, { mergedThresholds } from '../vitest.config.mjs';

export default mergeConfig(
  unit,
  defineConfig({
    test: {
      root: fileURLToPath(new URL('..', import.meta.url)),
      coverage: {
        reportsDirectory: './coverage/merged',
        reporter: ['text-summary', 'json', 'json-summary'],
        thresholds: mergedThresholds,
      },
    },
  }),
);
