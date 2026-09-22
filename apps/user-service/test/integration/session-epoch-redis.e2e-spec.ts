import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepositoryPort,
} from '../../src/modules/user/application/ports/password-reset-token-repository.port';
import {
  SESSION_EPOCH_PUBLISHER,
  type SessionEpochPublisherPort,
} from '../../src/modules/user/application/ports/session-epoch-publisher.port';
import { SessionEpochReconciler } from '../../src/modules/user/application/services/session-epoch-reconciler';
import { sha256Hex } from '../../src/modules/user/application/sha256-hex';
import { RedisSessionEpochPublisher } from '../../src/modules/user/infrastructure/redis-session-epoch.publisher';
import { authHeader, loginAs, sessionHeaders } from '../setup/auth.helper';
import { createTestUser, type TestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { publishedEpoch, storedEpoch } from '../setup/session-epoch.helper';

/** The real publisher, with a publish that can be made to fail outright, past its own retries. */
class DroppingEpochPublisher implements SessionEpochPublisherPort {
  private drops = 0;

  constructor(private readonly inner: SessionEpochPublisherPort) {}

  dropNext(): void {
    this.drops += 1;
  }

  get pendingDrops(): number {
    return this.drops;
  }

  reset(): void {
    this.drops = 0;
  }

  publish(userId: string, epoch: number): Promise<number> {
    if (this.drops > 0) {
      this.drops -= 1;
      return Promise.reject(new Error('publish dropped by the test'));
    }
    return this.inner.publish(userId, epoch);
  }
}

type BumpSite = [name: string, trigger: (subject: TestUser) => Promise<request.Response>, answers: number];

describe('Session epoch publication to Redis (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let publisher: DroppingEpochPublisher;

  const newPassword = 'NewPassword456!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({}, [
      {
        provide: SESSION_EPOCH_PUBLISHER,
        useFactory: (redis: RedisService) => new DroppingEpochPublisher(new RedisSessionEpochPublisher(redis)),
        inject: [RedisService],
      },
    ]));
    publisher = app.get<DroppingEpochPublisher>(SESSION_EPOCH_PUBLISHER);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  // A test that fails before its bump would otherwise leave the drop armed for the next one.
  beforeEach(() => {
    publisher.reset();
  });

  async function issueResetToken(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const repo = app.get<PasswordResetTokenRepositoryPort>(PASSWORD_RESET_TOKEN_REPOSITORY);
    await repo.create({ userId, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 3_600_000) });
    return raw;
  }

  // Each trigger publishes nothing before its bump, so a drop armed ahead of it lands on the bump.
  const sites: BumpSite[] = [
    [
      'logout-all',
      async ({ user, password }) => {
        const session = await loginAs(app, { email: user.email, password });
        return request(app.getHttpServer()).post('/auth/logout-all').set(authHeader(session.accessToken));
      },
      204,
    ],
    [
      'change-password',
      async ({ user, password }) => {
        const session = await loginAs(app, { email: user.email, password });
        return request(app.getHttpServer())
          .post('/auth/change-password')
          .set(authHeader(session.accessToken))
          .send({ currentPassword: password, newPassword });
      },
      204,
    ],
    [
      'password reset',
      async ({ user }) => {
        const token = await issueResetToken(user.id);
        return request(app.getHttpServer()).post('/auth/reset-password').send({ token, password: newPassword });
      },
      204,
    ],
    [
      'refresh-token reuse',
      async ({ user, password }) => {
        const session = await loginAs(app, { email: user.email, password });
        await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session)).expect(200);
        return request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session));
      },
      401,
    ],
  ];

  it.each(sites)('%s raises auth:epoch to the epoch it bumped to', async (_site, trigger, answers) => {
    const subject = await createTestUser(app);

    const res = await trigger(subject);

    expect(res.status).toBe(answers);
    expect(await storedEpoch(pool, subject.user.id)).toBe(1);
    expect(await publishedEpoch(app, subject.user.id)).toBe(1);
  });

  // The bump commits before the publish, so the revocation survives in Postgres and the next
  // reconcile pass carries it to Redis.
  it.each(sites)('%s answers 5xx when the publish fails, and one reconcile pass catches up', async (_site, trigger) => {
    const subject = await createTestUser(app);
    publisher.dropNext();

    const res = await trigger(subject);

    expect(res.status).toBe(500);
    expect(publisher.pendingDrops).toBe(0);
    expect(await storedEpoch(pool, subject.user.id)).toBe(1);
    expect(await publishedEpoch(app, subject.user.id)).toBeNull();

    await app.get(SessionEpochReconciler).reconcileOnce();

    expect(await publishedEpoch(app, subject.user.id)).toBe(1);
  });

  // A reset token is spent before the bump, so a publish failure that skipped the password write
  // would leave the old password working with no way to retry.
  it.each(sites.filter(([site]) => site === 'change-password' || site === 'password reset'))(
    '%s still replaces the password when the publish fails',
    async (_site, trigger) => {
      const subject = await createTestUser(app);
      publisher.dropNext();

      expect((await trigger(subject)).status).toBe(500);

      const login = (password: string) =>
        request(app.getHttpServer()).post('/auth/login').send({ email: subject.user.email, password });
      expect((await login(newPassword)).status).toBe(200);
      expect((await login(subject.password)).status).toBe(401);
    },
  );

  // Other services treat a missing key as a cache miss; a new account should never cause one.
  it('publishes epoch 0 for a new account at signup', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'fresh@test.local', password: 'Password123!' })
      .expect(201);

    expect(await publishedEpoch(app, res.body.id as string)).toBe(0);
  });
});
