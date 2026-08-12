import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config (root). Runs OUTSIDE Nest, so it loads `.env` itself via
 * `dotenv/config` (the app uses @nestjs/config instead). Schema entry is the
 * barrel; migrations are emitted next to the schema and committed to the repo.
 * See docs/adr/0005-orm-drizzle.md (source of truth).
 */
export default defineConfig({
  schema: './src/shared/infrastructure/database/schema/index.ts',
  out: './src/shared/infrastructure/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Empty fallback so a missing DATABASE_URL fails loudly in drizzle-kit
    // instead of tripping a type error here.
    url: process.env.DATABASE_URL ?? '',
  },
});
