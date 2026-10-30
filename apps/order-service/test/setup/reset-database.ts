import type { Pool } from 'pg';
import { apiInternalStub } from './api-internal-stub';
import { inventoryServiceStub } from './inventory-service-stub';
import { paymentServiceStub } from './payment-service-stub';

// Drizzle's ledger lives in the `drizzle` schema, so truncating `public` keeps the migrated structure.
// Each worker owns its database, so the TRUNCATE reaches only this worker's rows.
export async function resetDatabase(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows.length > 0) {
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
  // Carts, catalog, stock and payments live in the stubs; they go with the orders that point at them.
  (await apiInternalStub()).reset();
  (await inventoryServiceStub()).reset();
  (await paymentServiceStub()).reset();
}
