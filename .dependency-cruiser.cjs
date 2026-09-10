module.exports = {
  forbidden: [
    {
      name: 'no-cross-context-internals',
      severity: 'error',
      comment:
        'A bounded context may reach another context only through its application/public surface — never its domain, infrastructure, or schema.',
      from: { path: '^apps/[^/]+/src/modules/([^/]+)/' },
      to: {
        // `application` is in the list on purpose: without it a context could import another's
        // internal use cases and call the rule green. Same context is always fine; across contexts
        // only application/public is. One alternation string, not an array — `$1` group
        // interpolation is only documented for the scalar form. The app segment is non-capturing so
        // `$1` still names the context.
        path: '^apps/[^/]+/src/modules/[^/]+/(domain|infrastructure|application)/',
        pathNot: '^(apps/[^/]+/src/modules/$1/|apps/[^/]+/src/modules/[^/]+/application/public/)',
      },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'The domain layer must not depend on frameworks, the DB, or outer layers. It may use libs/kernel and libs/rbac (pure).',
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
        'domain/application stay telemetry-free: no OTel/pino/prom-client/Sentry, and observability only through the pure metrics port. The libs/observability barrel now transitively pulls @opentelemetry/api, so this keeps a stray `withSpan`/logger/captureException import from leaking telemetry into the core.',
      from: { path: '^apps/[^/]+/src/modules/[^/]+/(domain|application)/' },
      to: {
        path: 'node_modules/(@opentelemetry|@sentry|pino|nestjs-pino|prom-client)/|^libs/observability/',
        pathNot: '^libs/observability/src/metrics/metrics\\.port',
      },
    },
    {
      name: 'messaging-port-only-from-core',
      severity: 'error',
      comment:
        'domain/application may reach messaging only through its pure port. The package barrel pulls the Drizzle adapter and, transitively, @opentelemetry/api — which app-domain-telemetry-free cannot catch, because it matches direct edges only.',
      from: { path: '^apps/[^/]+/src/modules/[^/]+/(domain|application)/' },
      to: {
        path: '^libs/messaging/',
        pathNot: '^libs/messaging/src/outbox/outbox-writer\\.port',
      },
    },
    {
      name: 'kernel-pure',
      severity: 'error',
      comment: 'libs/kernel is the pure DDD building-block layer: it may import only itself.',
      from: { path: '^libs/kernel/' },
      to: { pathNot: '^libs/kernel/' },
    },
    {
      name: 'shared-no-module-internals',
      severity: 'error',
      comment:
        'libs/ is the leaf layer every app imports; importing a context back turns it into a hidden context. All of an app`s modules are off limits, including a context`s own *.module.ts, which drags its providers, controllers and schema along. No exemptions any more: the two former composition roots now sit in the app — the dispatch table behind DOMAIN_EVENT_DISPATCHER/EVENT_LABEL_REGISTRY, the schema barrel behind DrizzleModule.forRoot().',
      from: { path: '^libs/' },
      to: { path: '^apps/[^/]+/src/modules/' },
    },
    {
      name: 'libs-do-not-depend-on-apps',
      severity: 'error',
      comment:
        'A library is shared by every app, so it may not reach into one. Wider than shared-no-module-internals on purpose: it also covers an app`s composition roots (app.module, instrumentation, its messaging wiring and schema barrel), which are the edges a context-only rule lets through.',
      from: { path: '^libs/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-do-not-import-other-apps',
      severity: 'error',
      comment:
        'Apps are separate deployables. Anything two of them need belongs in libs/; a direct import would make the split a rename.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/[^/]+/', pathNot: '^apps/$1/' },
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
    tsConfig: { fileName: './tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: {
      path: 'node_modules|^apps/[^/]+/migrations/',
    },
  },
};
