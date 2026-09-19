module.exports = {
  forbidden: [
    {
      name: 'id-codec-pure',
      severity: 'error',
      comment:
        'Every service decodes ids and derives buckets with this package, so it may use only node builtins and the kernel.',
      from: { path: '^src/', pathNot: '\\.spec\\.ts$' },
      to: {
        pathNot: '^src/|^node_modules/@jcool/kernel/',
        dependencyTypesNot: ['core'],
      },
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
