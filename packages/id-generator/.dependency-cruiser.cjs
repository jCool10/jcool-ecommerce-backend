module.exports = {
  forbidden: [
    {
      name: 'id-generator-pure',
      severity: 'error',
      comment: 'Minting sits on every write path, so it may use only node builtins and the codec.',
      from: { path: '^src/', pathNot: '\\.spec\\.ts$' },
      to: {
        pathNot: '^src/|^node_modules/@jcool/id-codec/',
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
