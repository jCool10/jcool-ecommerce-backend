module.exports = {
  forbidden: [
    {
      name: 'contracts-standalone',
      severity: 'error',
      comment: 'Both ends of every internal API depend on this package, so it may use only node builtins.',
      from: { path: '^src/', pathNot: '\\.spec\\.ts$' },
      to: {
        pathNot: '^src/',
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'runtime-never-loads-testing',
      severity: 'error',
      comment: 'The contract cases are for test runners; production code reaches only the root entry.',
      from: { path: '^src/', pathNot: ['^src/testing\\.ts$', '/contract-cases\\.ts$', '/http-contract-driver\\.ts$', '\\.spec\\.ts$'] },
      to: { path: ['^src/testing\\.ts$', '/contract-cases\\.ts$', '/http-contract-driver\\.ts$'] },
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
    preserveSymlinks: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['require', 'node', 'default'] },
    tsConfig: { fileName: './tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
