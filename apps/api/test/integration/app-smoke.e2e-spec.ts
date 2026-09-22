import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '@jcool/platform/redis';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// Proves the harness boots against real Postgres + Redis (no mocks) and that
// resetDatabase() isolates each test.
describe('App smoke (real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('GET /health/ready → 200 with Postgres and Redis reachable', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info).toHaveProperty('database');
    expect(res.body.info).toHaveProperty('redis');
  });

  it('queries the real Postgres container (SELECT 1)', async () => {
    const db = app.get<DrizzleDB>(DRIZZLE);
    const result = await db.execute(sql`SELECT 1 AS ok`);
    expect(result.rows[0]).toEqual({ ok: 1 });
  });

  it('pings the real Redis container (PING → PONG)', async () => {
    const redis = app.get(RedisService);
    expect(await redis.ping()).toBe('PONG');
  });

  it('fixtures mint a principal and seed a priced SKU', async () => {
    const { user, accessToken } = await createTestPrincipal(app);
    const product = await createTestProduct(app, { priceMinor: 250_000 });

    expect(user.id).toBeTruthy();
    expect(accessToken.split('.')).toHaveLength(3); // header.payload.signature
    expect(product.sku).toMatch(/^TEST-SKU-/);
    expect(product.priceMinor).toBe(250_000);
  });

  // Both tests insert the SAME sku; without isolation the second would hit the
  // unique index — proving resetDatabase works.
  describe('resetDatabase gives each test a clean slate', () => {
    const sku = 'TEST-SKU-ISOLATION';

    it('first test inserts the shared sku', async () => {
      const product = await createTestProduct(app, { sku });
      expect(product.sku).toBe(sku);
    });

    it('second test reuses the same sku with no unique-violation', async () => {
      const product = await createTestProduct(app, { sku });
      expect(product.sku).toBe(sku);
    });
  });
});
