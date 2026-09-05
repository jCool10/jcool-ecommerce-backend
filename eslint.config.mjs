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
  // Id generation must stay fully synchronous. An `await` between reading the clock and stamping
  // the sequence lets a second caller interleave, and both emit the same (timestamp, node,
  // sequence) triple — a uniqueness break that only 40 random bits would still be covering. Fenced
  // across every file that section runs through, not just the generator: the same interleave is
  // reachable through the entropy draw and the encode it calls. Callers above `generate()` hold no
  // clock state between statements and are free to await.
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
  // Where user-context ids are minted. Every id here carries a routing bucket derived from the
  // owner's email, so an id from a general-purpose generator is unroutable — and, because nothing
  // reads a bucket until a shard split, unroutable rows go unnoticed for as long as it takes to get
  // there. The DB CHECK rejects such a row at write time; this catches the reach for one at edit
  // time. Not a global ban: `jti` and `familyId` have no bucket and stay on uuidv7. Specs are
  // exempt — proving a non-v8 id is rejected requires minting one.
  //
  // All of `scripts/` rather than only the seeder that writes users today: a script reaches the same
  // table over raw SQL, where nothing else stands between a stray `randomUUID()` and a row.
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
