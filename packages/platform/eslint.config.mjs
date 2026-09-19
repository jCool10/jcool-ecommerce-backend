// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
            'Keep the log message a static string and put the values in the fields object: logger.warn({ orderId, err: toError(caught) }, "sweep failed").',
        },
      ],
      'no-console': 'error',
    },
  },
  {
    files: ['src/**/*.spec.ts'],
    rules: { 'no-console': 'off' },
  },
);
