module.exports = {
  forbidden: [
    {
      name: 'outbox-port-stays-pure',
      severity: 'error',
      comment:
        'Domain and application code of every service import the port, so it may reach nothing at runtime: types only, and no queue, ORM or schema.',
      from: { path: '^src/outbox-port\\.ts$' },
      to: {
        path: ['bullmq', 'ioredis', 'drizzle-orm', '^src/(?!outbox-port\\.ts$)'],
      },
    },
    {
      name: 'schema-entry-stays-tables-only',
      severity: 'error',
      comment: 'drizzle-kit loads the schema entry of every service, so it must not pull Nest, BullMQ or the relay.',
      from: { path: '^src/schema\\.ts$' },
      to: { path: '^src/(?!schema\\.ts$|outbox/schema/|inbox/schema/)' },
    },
    {
      name: 'runtime-never-loads-testing',
      severity: 'error',
      comment: 'Test doubles are excluded from the build.',
      from: { path: '^src/', pathNot: ['^src/testing/', '\\.spec\\.ts$'] },
      to: { path: '^src/testing/' },
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
  },
};
