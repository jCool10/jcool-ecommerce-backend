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
        'Only the etcd module, the etcd store, its keyspace and the floor lift talk to etcd; everything else goes through NodeLease. The lease module only hands the client to the store.',
      from: {
        path: '^src/',
        pathNot: '^src/(etcd/|lease/(etcd-lease-|lift-floors|lease\\.module)|app\\.module)|\\.spec\\.ts$',
      },
      to: { path: '^node_modules/(etcd3|cockatiel)/|^src/etcd/' },
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
