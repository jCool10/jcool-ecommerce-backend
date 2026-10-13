// Workflow code runs in Temporal's sandbox and must replay the same way on every deploy, so it may
// reach only the saga contract, the pure saga domain and the workflow SDK. A separate config because
// the main one excludes npm packages from the graph, which leaves its rules blind to them.

const WORKFLOWS = '^src/modules/order/saga/workflows/';
const CONTRACT = '^src/modules/order/saga/checkout-saga\\.contract\\.ts$';
const SAGA_DOMAIN = '^src/modules/order/domain/(checkout-saga|checkout-saga-step|order-status)\\.ts$';
const ACTIVITIES = '^src/modules/order/saga/activities/checkout-saga\\.activities\\.ts$';
const WORKFLOW_CLOSURE = [WORKFLOWS, CONTRACT, SAGA_DOMAIN];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'workflow-sources-allowlist',
      severity: 'error',
      comment: 'Workflow code and what it pulls in reach only the contract, the pure saga domain and, for types, the activities.',
      from: { path: WORKFLOW_CLOSURE },
      to: { path: '^src/', pathNot: [...WORKFLOW_CLOSURE, ACTIVITIES] },
    },
    {
      name: 'workflow-activities-type-only',
      severity: 'error',
      comment: 'Activities run outside the sandbox; the workflow may only know their types.',
      from: { path: WORKFLOW_CLOSURE },
      to: { path: ACTIVITIES, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'workflow-packages-allowlist',
      severity: 'error',
      comment: 'Node built-ins and npm packages other than the workflow SDK and the pure kernel break determinism or the sandbox.',
      from: { path: WORKFLOW_CLOSURE },
      to: {
        dependencyTypes: ['core', 'npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'],
        pathNot: '(^|/)node_modules/(@temporalio/(workflow|common)|@jcool/kernel)/',
      },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', ACTIVITIES] },
    // Specs drive the workflow from outside the sandbox.
    exclude: { path: '\\.spec\\.ts$' },
    preserveSymlinks: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['require', 'node', 'default'] },
    tsConfig: { fileName: './tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
