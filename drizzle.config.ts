import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './apps/commerce-core/src/database/schema/index.ts',
  out: './apps/commerce-core/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Empty fallback so a missing DATABASE_URL fails loudly in drizzle-kit, not as a type error here.
    url: process.env.DATABASE_URL ?? '',
  },
});
