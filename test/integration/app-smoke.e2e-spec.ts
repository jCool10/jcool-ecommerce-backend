import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '../../src/shared/infrastructure/redis/redis.service';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Proves the harness boots against real Postgres + Redis (no mocks) and that
// resetDatabase() isolates each test.
describe('App smoke (real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

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

  it('fixtures seed a real user and a priced SKU', async () => {
    const { user, accessToken } = await createTestUser(app);
    const product = await createTestProduct(app, { priceMinor: 250_000 });

    expect(user.id).toBeTruthy();
    expect(accessToken.split('.')).toHaveLength(3); // header.payload.signature
    expect(product.sku).toMatch(/^TEST-SKU-/);
    expect(product.priceMinor).toBe(250_000);
  });

  // Both tests insert the SAME email; without isolation the second would hit the
  // unique index — proving resetDatabase works.
  describe('resetDatabase gives each test a clean slate', () => {
    const email = 'isolation@test.local';

    it('first test inserts the shared email', async () => {
      const { user } = await createTestUser(app, { email });
      expect(user.email).toBe(email);
    });

    it('second test reuses the same email with no unique-violation', async () => {
      const { user } = await createTestUser(app, { email });
      expect(user.email).toBe(email);
    });
  });
});
