import { readdirSync } from 'node:fs';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';

// Run as the pre-deploy step, apart from app boot, so a failed migration stops the rollout instead of
// crashlooping the replicas that were serving fine.

// A wrong path that still resolves to a readable directory makes drizzle report zero pending
// migrations and exit 0: a green deploy on an empty schema.
function countSqlFiles(folder: string): number {
  try {
    return readdirSync(folder).filter((name) => name.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

const sqlCount = countSqlFiles(MIGRATIONS_FOLDER);

if (sqlCount === 0) {
  console.error(`no .sql migrations found in ${MIGRATIONS_FOLDER}`);
  process.exit(1);
}

runMigrations()
  .then(() => {
    console.log(`migrations up to date from ${MIGRATIONS_FOLDER} (${sqlCount} files)`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('migration failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
