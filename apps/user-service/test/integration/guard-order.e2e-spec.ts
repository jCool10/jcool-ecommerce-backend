import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_THROTTLER, REFRESH_THROTTLE } from '@jcool/platform/throttler';
import { authHeader } from '../setup/auth.helper';
import { redisOf } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

// change-password is protected and sits on the refresh tier's IP limit.
const IP_LIMIT = REFRESH_THROTTLE[DEFAULT_THROTTLER].limit;

// The throttler runs ahead of the token check: a flood is shed before it costs a signature
// verification, and a caller over the limit learns nothing about its token.
describe('Global guard order (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp();
    await redisOf(app).flushdb();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  const changePassword = () =>
    request(app.getHttpServer())
      .post('/auth/change-password')
      .set(authHeader('not-a-token'))
      .send({ currentPassword: 'Password123!', newPassword: 'NewPassword456!' });

  it('answers 429, not 401, to a wrong bearer once the address is over its limit', async () => {
    for (let attempt = 0; attempt < IP_LIMIT; attempt++) {
      expect((await changePassword()).status).toBe(401);
    }

    expect((await changePassword()).status).toBe(429);
  });
});
