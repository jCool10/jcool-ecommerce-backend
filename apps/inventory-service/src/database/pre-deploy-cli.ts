import { runPreDeploy } from './pre-deploy';

// One process for both steps: Railway runs the pre-deploy command without a shell, so in `a && b` the
// `&& b` would only reach `a` as arguments.
runPreDeploy()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('pre-deploy failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
