import { migrateForDeploy } from './migrate';
import { runSeedStock } from './stock-top-up';

export interface PreDeployOptions {
  env?: Record<string, string | undefined>;
  migrationsFolder?: string;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** Migrates, then seeds best effort; a failed migration skips the seed. Seed faults past the catalog's throw. */
export async function runPreDeploy({ env = process.env, migrationsFolder, log = console }: PreDeployOptions = {}) {
  const migrated = await migrateForDeploy({ connectionString: env.DATABASE_URL, migrationsFolder, log });
  if (migrated !== 0) return migrated;
  return runSeedStock({ bestEffort: true, env, log });
}
