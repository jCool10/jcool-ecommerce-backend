// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// One logger, one call shape. See docs/logging-conventions.md.
const nestLoggerBan = {
  name: '@nestjs/common',
  importNames: ['Logger', 'ConsoleLogger'],
  message:
    'Inject PinoLogger from nestjs-pino and label it with logger.setContext(LOG_CONTEXT) in the constructor.',
};

const logCallShape = [
  {
    selector: "CallExpression[callee.object.property.name='logger'] > ObjectExpression > Property[key.name='context']",
    message:
      'Set the context once with logger.setContext(LOG_CONTEXT) in the constructor rather than stamping it on every call.',
  },
  {
    selector: "CallExpression[callee.object.property.name='logger'] > TemplateLiteral",
    message:
      'Keep the log message a static string and put the values in the fields object: logger.warn({ userId, err: toError(caught) }, "publish failed").',
  },
];

// An id from a general-purpose generator carries no routing bucket, and nothing notices until a
// shard split. `jti`/`familyId` carry no bucket and stay on uuidv7 in application/.
const bucketedIdMessage = 'User-context ids must be minted through IdentityService so they carry a routing bucket.';
const uuidImportBan = { group: ['uuid', 'uuid/*'], message: bucketedIdMessage };
const randomUuidBan = [
  { selector: "ImportSpecifier[imported.name='randomUUID']", message: bucketedIdMessage },
  { selector: "MemberExpression[property.name='randomUUID']", message: bucketedIdMessage },
];

const domainImportBan = {
  group: ['@nestjs/*', 'drizzle-orm', 'drizzle-orm/*', 'pg', 'ioredis'],
  message: 'domain/ must not import framework/DB. Keep domain pure; put adapters in infrastructure/.',
};

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'drizzle.config.ts', 'test/**/*.mts', 'src/database/migrations/**'],
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
    },
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
  {
    files: ['src/**/*.ts'],
    ignores: ['src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [nestLoggerBan] }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...logCallShape],
      'no-console': 'error',
    },
  },
  // A later block replaces an earlier block's options for the same rule, so the narrower blocks
  // below restate the logger entries they would otherwise drop.
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [nestLoggerBan], patterns: [domainImportBan] }],
    },
  },
  {
    files: ['src/modules/user/infrastructure/**/*.ts', 'src/modules/user/application/services/identity.service.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [nestLoggerBan], patterns: [uuidImportBan] }],
      'no-restricted-syntax': ['error', ...logCallShape, ...randomUuidBan],
    },
  },
  {
    files: ['scripts/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [uuidImportBan] }],
      'no-restricted-syntax': ['error', ...randomUuidBan],
    },
  },
  // Terminal output from processes that run outside Nest DI.
  {
    files: ['src/database/migrate.ts', 'src/database/migrate-cli.ts', 'scripts/**/*.ts', 'src/**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
