// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SYNC_ONLY = 'Id generation must stay synchronous: an await here can interleave two mints onto one sequence value.';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'prettier/prettier': 'error',
      'no-console': 'error',
    },
  },
  // `generate()` encodes through this package, so it is on the mint path.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'AwaitExpression', message: SYNC_ONLY },
        { selector: '[async=true]', message: SYNC_ONLY },
        { selector: 'ForOfStatement[await=true]', message: SYNC_ONLY },
      ],
    },
  },
);
