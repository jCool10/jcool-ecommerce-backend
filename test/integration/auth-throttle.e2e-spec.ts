import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Rate limiting is off in the default harness (the shared loopback IP would make every suite
// flaky), so this suite opts in explicitly. Emails are unique per run so a leftover Redis block
// from a previous run (15-min TTL) can't affect a fresh account bucket.
describe('Auth rate limiting (integration, real Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';
  const wrongPassword = 'WrongPassword9!';

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
    // Don't leak the flag into other e2e suites sharing this worker's env.
    delete process.env.THROTTLE_ENABLED;
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('locks a brute-forced account after repeated failures (429) without locking a different account on the same IP', async () => {
    const stamp = Date.now();
    const victim = `victim-${stamp}@throttle.local`;
    const bystander = `bystander-${stamp}@throttle.local`;

    await request(app.getHttpServer()).post('/auth/register').send({ email: victim, password }).expect(201);
    await request(app.getHttpServer()).post('/auth/register').send({ email: bystander, password }).expect(201);

    // The account tier allows 5 attempts per (IP, account) before locking out.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: victim, password: wrongPassword });
      expect(res.status).toBe(401);
    }

    // 6th attempt on the victim → rate-limited, not another credential check.
    const locked = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: victim, password: wrongPassword });
    expect(locked.status).toBe(429);

    // A different account from the same IP is unaffected: keying is per-account,
    // so brute force can't be weaponised to lock out other users behind one NAT.
    const bystanderLogin = await request(app.getHttpServer()).post('/auth/login').send({ email: bystander, password });
    expect(bystanderLogin.status).toBe(200);
  });
});
