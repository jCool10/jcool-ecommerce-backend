/**
 * Architecture boundary rules for the modular monolith (ADR 0009). Enforces the
 * DDD structure the plan established so boundaries stop depending on hand
 * discipline: run `npm run arch:check` (also wired into CI).
 *
 * Layering per context: interface → application → domain (inward only);
 * infrastructure implements ports via DI. Cross-context talk goes ONLY through
 * `application/public/**` (the published language) — never another context's
 * domain / infrastructure / schema. `shared/kernel` is pure.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-context-internals',
      severity: 'error',
      comment:
        'A bounded context may reach another context only through its application/public surface — never its domain, infrastructure, or schema.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/(domain|infrastructure)/',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'The domain layer must not depend on frameworks, the DB, or outer layers. It may use shared/kernel and shared/rbac (pure).',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: 'node_modules/(@nestjs|drizzle-orm|pg)/|^src/modules/[^/]+/(application|infrastructure|interface)/',
      },
    },
    {
      name: 'application-no-infra',
      severity: 'error',
      comment:
        'The application layer orchestrates domain + ports only; adapters (infrastructure) and controllers (interface) are wired in via DI, never imported.',
      from: { path: '^src/modules/[^/]+/application/' },
      to: { path: '^src/modules/[^/]+/(infrastructure|interface)/' },
    },
    {
      name: 'kernel-pure',
      severity: 'error',
      comment: 'shared/kernel is the pure DDD building-block layer: it may import only itself.',
      from: { path: '^src/shared/kernel/' },
      to: { pathNot: '^src/shared/kernel/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Dead file — nothing imports it and it imports nothing (excludes entry points, specs, barrels, published facades).',
      from: {
        orphan: true,
        pathNot: [
          '\\.(spec|test)\\.ts$',
          '\\.d\\.ts$',
          '(^|/)main\\.ts$',
          '(^|/)(migrate|seed)\\.ts$', // CLI entry scripts run by drizzle-kit / node, not imported
          '\\.module\\.ts$',
          '(^|/)index\\.ts$',
          '^src/modules/[^/]+/application/public/', // reserved published language; may be unconsumed until a cross-context caller lands
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: './tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: {
      // Type-only import graphs are covered; skip generated migration snapshots.
      path: 'node_modules|^src/shared/infrastructure/database/migrations/',
    },
  },
};
