import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// The lease owns its journal, so no app schema barrel re-exports the table and Phase 6 inherits the
// migrations without moving a file. Paths are repo-root relative, like the two app configs.
export default defineConfig({
  schema: './libs/identity/src/lease/node-lease.schema.ts',
  out: './libs/identity/src/lease/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.IDENTITY_LEASE_DATABASE_URL ?? '',
  },
});
