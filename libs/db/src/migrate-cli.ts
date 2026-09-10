import 'dotenv/config';
import { readdirSync } from 'node:fs';
import { LEASE_MIGRATIONS_FOLDER, MIGRATIONS_FOLDER, USER_MIGRATIONS_FOLDER, runMigrations } from './migrate';

// Separate from app bootstrap so a failed migration stops the rollout instead of crashlooping the
// app and taking down the version that was serving fine. `dotenv` is loaded here, not in the
// library module, so importing runMigrations() stays free of side effects.

// Which journal against which database. Naming the app rather than exporting one MIGRATIONS_DIR is
// what keeps a user deploy from applying commerce-core's history to the user database.
const TARGETS = {
  'commerce-core': { folder: MIGRATIONS_FOLDER, urlVar: 'DATABASE_URL' },
  user: { folder: USER_MIGRATIONS_FOLDER, urlVar: 'USER_DATABASE_URL' },
  leases: { folder: LEASE_MIGRATIONS_FOLDER, urlVar: 'IDENTITY_LEASE_DATABASE_URL' },
} as const;

// A migrations path that is wrong but still resolves to a readable directory makes drizzle report
// zero pending migrations and exit 0 — a green deploy on an empty schema. Fail loudly instead.
function countSqlFiles(folder: string): number {
  try {
    return readdirSync(folder).filter((name) => name.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

const app = process.argv[2] ?? 'commerce-core';
const target = TARGETS[app as keyof typeof TARGETS];

if (!target) {
  console.error(`unknown migration target "${app}" — expected one of ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

const sqlCount = countSqlFiles(target.folder);

if (sqlCount === 0) {
  console.error(`no .sql migrations found in ${target.folder}`);
  process.exit(1);
}

const connectionString = process.env[target.urlVar];

if (!connectionString) {
  console.error(`${target.urlVar} is required to migrate ${app}`);
  process.exit(1);
}

runMigrations(connectionString, target.folder)
  .then(() => {
    console.log(`migrations up to date from ${target.folder} (${sqlCount} files)`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('migration failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
