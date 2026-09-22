import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthTokensService } from '../../src/modules/user/application/services/auth-tokens.service';
import { authHeader } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { inProcessIdGenerator } from '../setup/test-app.factory';

// What a token minted before user ids became snowflakes carries.
const PRE_SNOWFLAKE_USER_ID = '0197c8f4-3a1b-8c2d-8e4f-1a2b3c4d5e6f';

describe('Access token subject (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const me = (token: string) => request(app.getHttpServer()).get('/auth/me').set(authHeader(token));
  // Signed with this app's own key, so the subject is the only thing that can be refused.
  const tokenFor = (sub: string) => app.get(AuthTokensService).signAccess(sub, 'CUSTOMER');

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('accepts a token for a user it holds', async () => {
    const { accessToken } = await createTestUser(app);

    expect((await me(accessToken)).status).toBe(200);
  });

  it('refuses a correctly signed token whose subject is a UUID', async () => {
    expect((await me(await tokenFor(PRE_SNOWFLAKE_USER_ID))).status).toBe(401);
  });

  it('refuses a routable subject it does not hold', async () => {
    const [unknownUserId] = await inProcessIdGenerator.mint(7);

    expect((await me(await tokenFor(unknownUserId))).status).toBe(401);
  });
});
