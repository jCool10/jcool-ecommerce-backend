import { RedisContainer } from '@testcontainers/redis';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UuidV8Generator } from '@jcool/id-generator';
import { ID_GENERATOR } from '../../src/modules/user/application/ports/id-generator.port';
import { IdServiceHttpAdapter } from '../../src/modules/user/infrastructure/id-service.http-adapter';
import { REDIS_IMAGE } from '../setup/global-setup';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { workerDatabaseUrl } from '../setup/worker-resources';

// The production module graph, booted as shipped: each case is a property of startup itself.
describe('Boot checks (integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  // A local generator would mint on a node id the id service's fleet already holds.
  it('builds no in-process id generator: every id comes from the id service', async () => {
    const app = await createTestApp({}, [], { realIdService: true });
    try {
      expect(() => app.get(UuidV8Generator)).toThrow();
      expect(app.get(ID_GENERATOR)).toBeInstanceOf(IdServiceHttpAdapter);
    } finally {
      await app.close();
    }
  });

  it('refuses a Redis that runs without an append-only file', async () => {
    const volatile = await new RedisContainer(REDIS_IMAGE).start();
    try {
      await expect(createTestApp({ REDIS_URL: volatile.getConnectionUrl() })).rejects.toThrow(
        /Redis cannot hold auth state: appendonly is off/,
      );
    } finally {
      await volatile.stop();
    }
  }, 120_000);

  // This database is filled by copying the api's, pin included; a pin written first would be wrong.
  it('writes no key pin on an empty database while IDENTITY_PIN_BOOTSTRAP is off', async () => {
    const app = await createTestApp({ IDENTITY_PIN_BOOTSTRAP: 'false' });
    try {
      const { rows } = await pool.query(`SELECT 1 FROM identity_key_pin`);
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
