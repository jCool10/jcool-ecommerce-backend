import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { runMigrations } from '../../src/database/migrate';
import { POSTGRES_IMAGE, TEMPLATE_DATABASE, withDatabase } from './databases';

// Migrated once into a template; every spec clones its own database from it.
export default async function setup({
  provide,
}: {
  provide: (key: 'PG_ADMIN_URL', value: string) => void;
}): Promise<() => Promise<void>> {
  const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  try {
    const adminUrl = postgres.getConnectionUri();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
    } finally {
      await admin.end();
    }
    await runMigrations(withDatabase(adminUrl, TEMPLATE_DATABASE));
    provide('PG_ADMIN_URL', adminUrl);
  } catch (error) {
    await postgres.stop();
    throw error;
  }
  return async () => {
    await postgres.stop();
  };
}
