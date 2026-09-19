module.exports = {
  forbidden: [
    {
      name: 'no-local-id-generator',
      severity: 'error',
      comment:
        'Ids come from the id service. An in-process generator would mint on a node id the fleet already uses; only scripts/ and test/ may run one, on the node reserved for them.',
      from: { path: '^src/' },
      to: { path: '^node_modules/@jcool/id-generator/' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'The domain layer must not depend on frameworks, the DB, or outer layers.',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: 'node_modules/(@nestjs|drizzle-orm|pg)/|^src/modules/[^/]+/(application|infrastructure|interface)/',
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
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Dead file — nothing imports it and it imports nothing.',
      from: {
        orphan: true,
        pathNot: [
          '\\.(spec|test)\\.ts$',
          '\\.d\\.ts$',
          '(^|/)main\\.ts$',
          '(^|/)migrate(-cli)?\\.ts$',
          '\\.module\\.ts$',
          '(^|/)index\\.ts$',
          '^scripts/',
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
      // @jcool packages stay in the graph so rules can match edges into them.
      path: 'node_modules/(?!@jcool/)|^src/database/migrations/',
    },
  },
};
