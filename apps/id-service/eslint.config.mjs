// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'drizzle.config.ts', 'test/**/*.mts'],
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
      // Nest's Logger bypasses the pino pipeline and its request/job/trace correlation. See docs/logging-conventions.md.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/common',
              importNames: ['Logger', 'ConsoleLogger'],
              message:
                'Inject PinoLogger from nestjs-pino and label it with logger.setContext(LOG_CONTEXT) in the constructor.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.property.name='logger'] > ObjectExpression > Property[key.name='context']",
          message:
            'Set the context once with logger.setContext(LOG_CONTEXT) in the constructor rather than stamping it on every call.',
        },
        {
          selector: "CallExpression[callee.object.property.name='logger'] > TemplateLiteral",
          message:
            'Keep the log message a static string and put the values in the fields object: logger.warn({ nodeId, err: toError(caught) }, "renew failed").',
        },
      ],
      'no-console': 'error',
    },
  },
  // The bootstrap logger runs before the pino provider exists.
  {
    files: ['src/main.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // Migrations run outside Nest, with no logger to inject.
  {
    files: ['src/**/*.spec.ts', 'test/**/*.ts', 'src/database/migrate.ts', 'src/database/migrate-cli.ts'],
    rules: { 'no-console': 'off' },
  },
  // `getHttpServer()` is typed `any`, so every supertest call trips the unsafe-* family.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
