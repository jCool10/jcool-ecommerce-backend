import { resolve } from 'node:path';
import { CHECKOUT_SAGA_BUNDLE_FILE, bundleCheckoutSagaWorkflows } from './workflow-bundle';

// Runs after `nest build`, from the app directory. The image has no TypeScript sources, so the
// production worker loads this prebuilt bundle instead of bundling at boot.
const outFile = resolve(CHECKOUT_SAGA_BUNDLE_FILE);

bundleCheckoutSagaWorkflows(outFile)
  .then(() => {
    console.log(`checkout saga workflows bundled to ${outFile}`);
  })
  .catch((error: unknown) => {
    console.error('workflow bundle failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
