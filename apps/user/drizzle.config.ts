import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Paths are repo-root relative: drizzle-kit resolves them against the CWD npm scripts run from.
export default defineConfig({
  schema: './apps/user/src/database/schema/index.ts',
  out: './apps/user/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.USER_DATABASE_URL ?? '',
  },
});
