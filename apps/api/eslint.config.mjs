// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// One logger, one call shape. See docs/logging-conventions.md.
//
// `Logger` from @nestjs/common writes outside the pino pipeline: no requestId, no job/trace
// correlation, no `context` unless it is hand-passed, and the only way to carry a value is to
// interpolate it into the message — which throws the stack away and gives every occurrence of one
// event a distinct message string, so no aggregator can group them. main.ts is the exception: the
// bootstrap logger runs before the pino provider exists.
const nestLoggerBan = {
  name: '@nestjs/common',
  importNames: ['Logger', 'ConsoleLogger'],
  message:
    'Inject PinoLogger from nestjs-pino and label it with logger.setContext(LOG_CONTEXT) in the constructor.',
};

const logCallShape = [
  // PinoLogger is transient — one instance per injection site — so setContext() in the
  // constructor stamps `context` on every line this class writes. Repeating it per call is
  // both noise and a chance to drift. (A free function that takes a logger PARAMETER calls it
  // as `logger.warn(...)`, not `this.logger.warn(...)`, and is deliberately not matched: it
  // has no constructor to label in, so it passes `context` per call.)
  {
    selector: "CallExpression[callee.object.property.name='logger'] > ObjectExpression > Property[key.name='context']",
    message:
      'Set the context once with logger.setContext(LOG_CONTEXT) in the constructor rather than stamping it on every call.',
  },
  // The message is the group key. Interpolated values belong in fields, and a caught error
  // belongs in `err: toError(caught)` — pino serializes it into type/message/stack.
  {
    selector: "CallExpression[callee.object.property.name='logger'] > TemplateLiteral",
    message:
      'Keep the log message a static string and put the values in the fields object: logger.warn({ orderId, err: toError(caught) }, "sweep failed").',
  },
];

// An id from a general-purpose generator carries no routing bucket, and nothing notices until a
// shard split. Not a global ban: `jti`/`familyId` have no bucket and stay on uuidv7, and specs must
// be able to mint a non-v8 id to prove it is rejected. `scripts/` is in because it inserts over raw SQL.
const bucketedIdMessage =
  'User-context ids must be minted through IdentityService so they carry a routing bucket.';
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
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Options come solely from .prettierrc, so `eslint --fix` and `prettier --write` never fight.
      'prettier/prettier': 'error',
    },
  },
  // `INestApplication.getHttpServer()` is typed `any`, so every supertest call in the e2e tier trips
  // the unsafe-* family. Relaxed here only; the correctness rules stay on — an un-awaited supertest
  // request is never sent, and the spec goes green having asserted nothing.
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
      // Application logs go through PinoLogger. The exceptions below are operator-facing terminal
      // output from processes that run outside Nest DI, where there is no logger to inject.
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
    files: ['src/modules/user/infrastructure/**/*.ts', 'src/shared/identity/identity.service.ts'],
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
  {
    files: [
      'src/shared/infrastructure/database/migrate.ts',
      'src/shared/infrastructure/database/migrate-cli.ts',
      'src/shared/infrastructure/database/seed.ts',
      'src/shared/infrastructure/storage/verify-storage-orphans.cli.ts',
      'src/shared/messaging/queue/replay-dlq.cli.ts',
      'src/modules/catalog/infrastructure/search/reindex.ts',
      'src/**/*.spec.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
);
