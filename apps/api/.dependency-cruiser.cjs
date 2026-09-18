module.exports = {
  forbidden: [
    {
      name: 'no-cross-context-internals',
      severity: 'error',
      comment:
        'A bounded context may reach another context only through its application/public surface — never its domain, infrastructure, or schema.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        // `application` is in the list on purpose: without it a context could import another's
        // internal use cases and call the rule green. Same context is always fine; across contexts
        // only application/public is. One alternation string, not an array — `$1` group
        // interpolation is only documented for the scalar form.
        path: '^src/modules/[^/]+/(domain|infrastructure|application)/',
        pathNot: '^(src/modules/$1/|src/modules/[^/]+/application/public/)',
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
      name: 'app-domain-telemetry-free',
      severity: 'error',
      comment:
        'domain/application stay telemetry-free: no OTel/pino/prom-client/Sentry, and observability only through the pure metrics port. The shared/observability barrel now transitively pulls @opentelemetry/api, so this keeps a stray `withSpan`/logger/captureException import from leaking telemetry into the core.',
      from: { path: '^src/modules/[^/]+/(domain|application)/' },
      to: {
        path: 'node_modules/(@opentelemetry|@sentry|pino|nestjs-pino|prom-client)/|^src/shared/observability/',
        pathNot: '^src/shared/observability/metrics/metrics\\.port',
      },
    },
    {
      name: 'messaging-port-only-from-core',
      severity: 'error',
      comment:
        'domain/application may reach messaging only through its pure port. The package barrel pulls the Drizzle adapter and, transitively, @opentelemetry/api — which app-domain-telemetry-free cannot catch, because it matches direct edges only.',
      from: { path: '^src/modules/[^/]+/(domain|application)/' },
      to: {
        path: '^src/shared/messaging/',
        pathNot: '^src/shared/messaging/outbox/outbox-writer\\.port',
      },
    },
    {
      name: 'kernel-pure',
      severity: 'error',
      comment: 'shared/kernel is the pure DDD building-block layer: it may import only itself.',
      from: { path: '^src/shared/kernel/' },
      to: { pathNot: '^src/shared/kernel/' },
    },
    {
      name: 'shared-no-module-internals',
      severity: 'error',
      comment:
        'shared/ is the leaf layer every context imports; importing a context back turns it into a hidden context. All of src/modules is off limits, including a context`s own *.module.ts, which drags its providers, controllers and schema along. Exempt: the two composition roots — shared/messaging wires context handlers into DI, and the schema barrel collects every context table for the migrator.',
      from: {
        path: '^src/shared/',
        pathNot: '^src/shared/(messaging|infrastructure/database/schema)/',
      },
      to: { path: '^src/modules/' },
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
          '(^|/)instrumentation\\.ts$', // OTel preload — loaded via `node --import`, never imported

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
      path: 'node_modules|^src/shared/infrastructure/database/migrations/',
    },
  },
};
