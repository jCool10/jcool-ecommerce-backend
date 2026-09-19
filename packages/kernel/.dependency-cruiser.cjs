module.exports = {
  forbidden: [
    {
      name: 'kernel-pure',
      severity: 'error',
      comment: 'Every other package and app imports the kernel, so it may import nothing but itself.',
      from: { path: '^src/', pathNot: '\\.spec\\.ts$' },
      to: { pathNot: '^src/' },
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
    // Keeps links under node_modules, so only a genuine escape resolves to ../
    preserveSymlinks: true,
    tsConfig: { fileName: './tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
