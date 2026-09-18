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
  {
    files: ['src/**/*.spec.ts'],
    rules: { 'no-console': 'off' },
  },
  // An await between reading the clock and stamping the sequence lets two callers emit the same
  // (timestamp, node, sequence) triple. Callers above `generate()` hold no clock state and may await.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/node-lease.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'AwaitExpression', message: SYNC_ONLY },
        { selector: '[async=true]', message: SYNC_ONLY },
        { selector: 'ForOfStatement[await=true]', message: SYNC_ONLY },
      ],
    },
  },
  // The lease awaits its store, but its mint path, including the fence check, stays synchronous.
  {
    files: ['src/node-lease.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'MethodDefinition[key.name=/^(generate|fenced)$/] AwaitExpression', message: SYNC_ONLY },
        { selector: 'MethodDefinition[key.name=/^(generate|fenced)$/] > [async=true]', message: SYNC_ONLY },
      ],
    },
  },
);
