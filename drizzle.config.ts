import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Runs outside Nest, so it loads `.env` itself via `dotenv/config` (the app uses @nestjs/config).
export default defineConfig({
  schema: './src/shared/infrastructure/database/schema/index.ts',
  out: './src/shared/infrastructure/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Empty fallback so a missing DATABASE_URL fails loudly in drizzle-kit, not as a type error here.
    url: process.env.DATABASE_URL ?? '',
  },
});
