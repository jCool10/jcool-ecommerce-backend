import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAppWithPool, redisOf, resetDatabaseBeforeEach } from '../setup/harness';

// Throttling is off in the default harness (every suite shares one loopback IP).
describe('Auth rate limiting (integration, real Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';
  const wrongPassword = 'WrongPassword9!';

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    ({ app, pool } = await createTestAppWithPool());
    // Counters outlive the app in this worker's Redis db.
    await redisOf(app).flushdb();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  resetDatabaseBeforeEach(() => pool);

  it('locks a brute-forced account without locking another on the same IP', async () => {
    const stamp = Date.now();
    const victim = `victim-${stamp}@throttle.local`;
    const bystander = `bystander-${stamp}@throttle.local`;

    await request(app.getHttpServer()).post('/auth/register').send({ email: victim, password }).expect(201);
    await request(app.getHttpServer()).post('/auth/register').send({ email: bystander, password }).expect(201);

    // The account tier allows 5 attempts per (IP, account).
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: victim, password: wrongPassword });
      expect(res.status).toBe(401);
    }

    const locked = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: victim, password: wrongPassword });
    expect(locked.status).toBe(429);

    // Keyed per account, so brute force cannot lock out everyone behind one NAT.
    const bystanderLogin = await request(app.getHttpServer()).post('/auth/login').send({ email: bystander, password });
    expect(bystanderLogin.status).toBe(200);
  });
});
