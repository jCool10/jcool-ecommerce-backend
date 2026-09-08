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
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // No inline overrides: options come solely from .prettierrc, so `eslint --fix` and
      // `prettier --write` never fight.
      'prettier/prettier': 'error',
    },
  },
  // Id generation must stay synchronous: an await between reading the clock and stamping the sequence
  // lets two callers emit the same (timestamp, node, sequence) triple. Fenced across every file
  // `generate()` runs through; callers above it hold no clock state and are free to await.
  {
    files: [
      'src/shared/identity/uuid-v8.generator.ts',
      'src/shared/identity/entropy-pool.ts',
      'src/shared/identity/uuid-v8.codec.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AwaitExpression',
          message: 'Id generation must stay synchronous: an await here can interleave two mints onto one sequence value.',
        },
        {
          selector: '[async=true]',
          message: 'Id generation must stay synchronous: an async function here can interleave two mints onto one sequence value.',
        },
        {
          selector: 'ForOfStatement[await=true]',
          message: 'Id generation must stay synchronous: an await here can interleave two mints onto one sequence value.',
        },
      ],
    },
  },
  // An id from a general-purpose generator carries no routing bucket, and nothing notices until a
  // shard split. Not a global ban: `jti`/`familyId` have no bucket and stay on uuidv7, and specs must
  // be able to mint a non-v8 id to prove it is rejected. All of `scripts/`, because scripts reach the
  // table over raw SQL.
  {
    files: [
      'src/modules/user/infrastructure/**/*.ts',
      'src/shared/identity/identity.service.ts',
      'scripts/**/*.ts',
    ],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['uuid', 'uuid/*'],
              message: 'User-context ids must be minted through IdentityService so they carry a routing bucket.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportSpecifier[imported.name='randomUUID']",
          message: 'User-context ids must be minted through IdentityService so they carry a routing bucket.',
        },
        {
          selector: "MemberExpression[property.name='randomUUID']",
          message: 'User-context ids must be minted through IdentityService so they carry a routing bucket.',
        },
      ],
    },
  },
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
