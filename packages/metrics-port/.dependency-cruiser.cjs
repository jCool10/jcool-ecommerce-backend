module.exports = {
  forbidden: [
    {
      name: 'metrics-port-pure',
      severity: 'error',
      comment: 'Domain and application code depend on this seam, so it may not pull prom-client or a framework with it.',
      from: { path: '^src/' },
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
