module.exports = {
  forbidden: [
    {
      name: 'no-local-id-generator',
      severity: 'error',
      comment:
        'Ids come from the id service. An in-process generator would mint on a node id the fleet already uses; only test/ may run one, on the node reserved for it.',
      from: { path: '^src/' },
      to: { path: '^node_modules/@jcool/id-generator/' },
    },
    {
      name: 'runtime-never-loads-contract-cases',
      severity: 'error',
      comment: 'The shared case table and its HTTP driver are test code.',
      from: { path: '^src/', pathNot: '\\.spec\\.ts$' },
      to: { path: '^node_modules/@jcool/internal-contracts/dist/testing' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'The domain layer must not depend on frameworks, the DB, or outer layers.',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: 'node_modules/(@nestjs|@temporalio|drizzle-orm|pg)/|^src/modules/[^/]+/(application|infrastructure|interface)/',
      },
    },
    {
      name: 'application-no-infra',
      severity: 'error',
      comment: 'Adapters (infrastructure) and controllers (interface) are wired in via DI, never imported.',
      from: { path: '^src/modules/[^/]+/application/' },
      to: { path: '^src/modules/[^/]+/(infrastructure|interface)/' },
    },
    {
      name: 'app-domain-telemetry-free',
      severity: 'error',
      comment: 'domain/application reach observability only through the pure metrics port.',
      from: { path: '^src/modules/[^/]+/(domain|application)/' },
      to: {
        path: 'node_modules/(@opentelemetry|@sentry|pino|nestjs-pino|prom-client)/|^node_modules/@jcool/platform/dist/observability/',
      },
    },
    {
      name: 'messaging-port-only-from-core',
      severity: 'error',
      comment:
        'domain/application may reach messaging only through its pure port; the package root pulls bullmq, the Drizzle adapter and @opentelemetry/api.',
      from: { path: '^src/modules/[^/]+/(domain|application)/' },
      to: {
        path: '^src/shared/messaging/|^node_modules/@jcool/messaging/',
        pathNot: '^node_modules/@jcool/messaging/dist/outbox-port\\.',
      },
    },
    {
      name: 'shared-no-module-internals',
      severity: 'error',
      comment:
        'shared/ is the leaf layer the module imports. Exempt: shared/messaging, which wires the module`s handlers into DI.',
      from: { path: '^src/shared/', pathNot: '^src/shared/messaging/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'workflow-sandbox-imports',
      severity: 'error',
      comment:
        'Workflow code is bundled alone into the deterministic sandbox: only the Temporal workflow API, the saga contract and the pure saga domain may come in. Node core, Nest, the DB, the other Temporal packages and every other layer either break the bundle or break replay.',
      from: { path: '^src/modules/order/infrastructure/temporal/workflows/' },
      to: {
        pathNot: [
          '^src/modules/order/infrastructure/temporal/workflows/',
          '^src/modules/order/infrastructure/temporal/checkout-saga\\.(contract|activities)\\.ts$',
          '^src/modules/order/domain/(checkout-saga|order-status)\\.ts$',
          '(^|/)node_modules/@temporalio/(workflow|common)/',
        ],
      },
    },
    {
      name: 'workflow-activities-type-only',
      severity: 'error',
      comment: 'The workflow may name the activities type, never load the Nest class that implements it.',
      from: { path: '^src/modules/order/infrastructure/temporal/workflows/' },
      to: {
        path: '^src/modules/order/infrastructure/temporal/checkout-saga\\.activities\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Dead file — nothing imports it and it imports nothing.',
      from: {
        orphan: true,
        pathNot: [
          '\\.(spec|test)\\.ts$',
          '\\.d\\.ts$',
          '(^|/)main\\.ts$',
          '(^|/)instrumentation\\.ts$',
          '(^|/)migrate(-cli)?\\.ts$',
          '\\.cli\\.ts$',
          '\\.module\\.ts$',
          '(^|/)index\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'no-reach-outside-package',
      severity: 'error',
      comment: 'Another package or app is reached through its published name, never a relative path out of this one.',
      from: {},
      to: { path: '^\\.\\./' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Keeps workspace links under node_modules/@jcool, so only a genuine escape resolves to ../
    preserveSymlinks: true,
    // Workspace packages publish only `exports`, keyed on `default`, which the resolver skips unless named.
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['require', 'node', 'default'] },
    tsConfig: { fileName: './tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: {
      // Packages a rule matches on stay in the graph (unfollowed), or edges into them are invisible.
      path: 'node_modules/(?!(@jcool|@temporalio|@nestjs)/|drizzle-orm/|pg/)|^src/database/migrations/',
    },
  },
};
