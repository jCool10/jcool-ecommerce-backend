module.exports = {
  forbidden: [
    {
      name: 'no-reach-outside-package',
      severity: 'error',
      comment: 'Another package or app is reached through its published name, never a relative path out of this one.',
      from: {},
      to: { path: '^\\.\\./' },
    },
    {
      name: 'lease-store-behind-port',
      severity: 'error',
      comment:
        'Only the Postgres store and the migration runner talk SQL; everything else goes through NodeLease. The root module only hands the schema to Drizzle.',
      from: { path: '^src/', pathNot: '^src/(lease/postgres-lease-store|database/|app\\.module)|\\.spec\\.ts$' },
      to: { path: '^node_modules/(drizzle-orm|pg)/|^src/database/' },
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
