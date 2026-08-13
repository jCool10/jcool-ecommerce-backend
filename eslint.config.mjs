// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Aligns with docs/code-standards.md ("no any") and its reliability rules
      // (idempotent consumers, transactional writes) — an un-awaited promise is
      // a real correctness bug, not a style nit.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      // Honour the `_`-prefix convention for deliberately-unused bindings (e.g. a
      // fake implementing a wider signature than it needs).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Prettier options come solely from .prettierrc (single source of truth);
      // no inline overrides so `eslint --fix` and `prettier --write` never fight.
      'prettier/prettier': 'error',
    },
  },
  // Clean Architecture boundary: domain/ must stay framework/DB-free (basic guard, tightened over time).
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'pg',
                'ioredis',
              ],
              message:
                'domain/ must not import framework/DB. Keep domain pure; put adapters in infrastructure/.',
            },
          ],
        },
      ],
    },
  },
);
