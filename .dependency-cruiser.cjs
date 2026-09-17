module.exports = {
  forbidden: [
    {
      name: 'no-cross-app',
      severity: 'error',
      comment: 'Apps are separate deployables: an app reaches another only over the wire, never by import.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-cross-context-internals',
      severity: 'error',
      comment:
        'A bounded context may reach another context only through its application/public surface — never its domain, infrastructure, or schema.',
      from: { path: '^apps/([^/]+)/src/modules/([^/]+)/' },
      to: {
        // `application` is in the list on purpose: without it a context could import another's
        // internal use cases and call the rule green. Same context is always fine; across contexts
        // only application/public is. One alternation string, not an array — `$1` group
        // interpolation is only documented for the scalar form.
        path: '^apps/[^/]+/src/modules/[^/]+/(domain|infrastructure|application)/',
        pathNot: '^(apps/$1/src/modules/$2/|apps/$1/src/modules/[^/]+/application/public/)',
      },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'The domain layer must not depend on frameworks, the DB, or outer layers. It may use @jcool/kernel and shared/rbac (pure).',
      from: { path: '^apps/[^/]+/src/modules/[^/]+/domain/' },
      to: {
        path: 'node_modules/(@nestjs|drizzle-orm|pg)/|^apps/[^/]+/src/modules/[^/]+/(application|infrastructure|interface)/',
      },
    },
    {
      name: 'application-no-infra',
      severity: 'error',
      comment:
        'The application layer orchestrates domain + ports only; adapters (infrastructure) and controllers (interface) are wired in via DI, never imported.',
      from: { path: '^apps/[^/]+/src/modules/[^/]+/application/' },
      to: { path: '^apps/[^/]+/src/modules/[^/]+/(infrastructure|interface)/' },
    },
    {
      name: 'app-domain-telemetry-free',
      severity: 'error',
      comment:
        'domain/application stay telemetry-free: no OTel/raw pino/prom-client/Sentry, and observability only through the pure metrics port. The injected PinoLogger (nestjs-pino) is allowed. The shared/observability barrel now transitively pulls @opentelemetry/api, so this keeps a stray `withSpan`/captureException import from leaking telemetry into the core.',
      from: { path: '^apps/[^/]+/src/modules/[^/]+/(domain|application)/' },
      to: {
        path: 'node_modules/(@opentelemetry|@sentry|pino|prom-client)/|^apps/[^/]+/src/shared/observability/',
        pathNot: '^apps/[^/]+/src/shared/observability/metrics/metrics\\.port',
      },
    },
    {
      name: 'messaging-port-only-from-core',
      severity: 'error',
      comment:
        'domain/application may reach messaging only through its pure port. The package barrel pulls the Drizzle adapter and, transitively, @opentelemetry/api — which app-domain-telemetry-free cannot catch, because it matches direct edges only.',
      from: { path: '^apps/[^/]+/src/modules/[^/]+/(domain|application)/' },
      to: {
        path: '^apps/[^/]+/src/shared/messaging/',
        pathNot: '^apps/[^/]+/src/shared/messaging/outbox/outbox-writer\\.port',
      },
    },
    {
      name: 'packages-no-apps',
      severity: 'error',
      comment: 'Packages are shared by every app, so none of them may depend on one.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'kernel-pure',
      severity: 'error',
      comment:
        '@jcool/kernel is the pure DDD building-block layer: it may import only itself — no npm package, no node builtin.',
      from: { path: '^packages/kernel/src/', pathNot: '\\.spec\\.ts$' },
      to: { pathNot: '^packages/kernel/src/' },
    },
    {
      name: 'identity-pure',
      severity: 'error',
      comment:
        '@jcool/identity may import only itself, the @jcool/kernel entry point and node builtins. Nest DI, config and metrics binding stay in each app (identity.module.ts).',
      from: { path: '^packages/identity/src/', pathNot: '\\.spec\\.ts$' },
      to: { pathNot: '^packages/(identity/src/|kernel/src/index\\.ts$)', dependencyTypesNot: ['core'] },
    },
    {
      name: 'no-legacy-shared-paths',
      severity: 'error',
      comment:
        'kernel and identity live in packages. A copy under shared/ is a second class: `instanceof DomainError` misses it and the filter answers 500 instead of 422. Only the app-owned identity.module stays.',
      from: {},
      to: {
        path: '^apps/[^/]+/src/shared/(kernel|identity)/',
        pathNot: '^apps/[^/]+/src/shared/identity/identity\\.module\\.ts$',
      },
    },
    {
      name: 'shared-no-module-internals',
      severity: 'error',
      comment:
        'shared/ is the leaf layer every context imports; importing a context back turns it into a hidden context. All of src/modules is off limits, including a context`s own *.module.ts, which drags its providers, controllers and schema along. Exempt: the two composition roots — shared/messaging wires context handlers into DI, and the schema barrel collects every context table for the migrator.',
      from: {
        path: '^apps/[^/]+/src/shared/',
        pathNot: '^apps/[^/]+/src/shared/(messaging|infrastructure/database/schema)/',
      },
      to: { path: '^apps/[^/]+/src/modules/' },
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
          '^apps/[^/]+/src/modules/[^/]+/application/public/', // reserved published language; may be unconsumed until a cross-context caller lands
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Absolute: a relative path breaks the app tsconfig's `extends` and `include` resolution (TS5083).
    tsConfig: { fileName: require('node:path').join(__dirname, 'apps/checkout-core/tsconfig.json') },
    tsPreCompilationDeps: true,
    // Not node_modules: an excluded edge never reaches the rules, so every npm target above would pass.
    exclude: {
      path: '^apps/[^/]+/src/shared/infrastructure/database/migrations/',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      // Workspace packages resolve to source, as tsc and tsx see them.
      conditionNames: ['@jcool/source', 'require', 'node', 'default'],
    },
  },
};
