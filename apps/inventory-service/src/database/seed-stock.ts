import { runSeedStock } from './stock-top-up';

// `--best-effort` is the pre-deploy step, which must not fail a rollout over a catalog that cannot be
// listed; without it (`pnpm db:seed`) an unlistable or empty catalog exits 1.
runSeedStock({ bestEffort: process.argv.includes('--best-effort') })
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('stock seed failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
