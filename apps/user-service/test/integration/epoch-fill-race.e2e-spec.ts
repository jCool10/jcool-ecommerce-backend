import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import {
  SESSION_EPOCH,
  SESSION_EPOCH_PUBLISHER,
  type SessionEpochPort,
  type SessionEpochPublisherPort,
} from '../../src/modules/user/application/ports';
import { RedisSessionEpochPublisher } from '../../src/modules/user/infrastructure/redis-session-epoch.publisher';
import { authHeader } from '../setup/auth.helper';
import { E2E_INTERNAL_API_TOKEN } from '../setup/e2e-env';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { publishedEpoch, storedEpoch } from '../setup/session-epoch.helper';

const ROUNDS = 5;
const BUMPS = 10;
const FILLS = 30;
const JITTER_MS = 15;

/**
 * The real publisher behind a delay the test controls. Left alone, a fill's read-then-publish gap is
 * far too short for a bump to land inside it, and the race never happens.
 */
class ReorderingPublisher implements SessionEpochPublisherPort {
  jitterMs = 0;
  private hold: { arrived: () => void; released: Promise<void> } | null = null;

  constructor(private readonly inner: SessionEpochPublisherPort) {}

  /** The next publish stops before reaching Redis until `release` is called. */
  holdNext(): { arrived: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const arrival = new Promise<void>((resolve) => (arrived = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.hold = { arrived, released };
    return { arrived: arrival, release };
  }

  async publish(userId: string, epoch: number): Promise<number> {
    const hold = this.hold;
    if (hold) {
      this.hold = null;
      hold.arrived();
      await hold.released;
    } else if (this.jitterMs > 0) {
      await sleep(Math.random() * this.jitterMs);
    }
    return this.inner.publish(userId, epoch);
  }
}

// A fill reads the epoch and publishes it later; a bump landing in between must not be undone by
// the stale value arriving second.
describe('Session epoch fill racing bumps (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let publisher: ReorderingPublisher;
  let epochs: SessionEpochPort;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({}, [
      {
        provide: SESSION_EPOCH_PUBLISHER,
        useFactory: (redis: RedisService) => new ReorderingPublisher(new RedisSessionEpochPublisher(redis)),
        inject: [RedisService],
      },
    ]));
    publisher = app.get<ReorderingPublisher>(SESSION_EPOCH_PUBLISHER);
    epochs = app.get<SessionEpochPort>(SESSION_EPOCH);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(() => {
    publisher.jitterMs = 0;
  });

  const fill = (userId: string): Promise<request.Response> =>
    request(app.getHttpServer())
      .get(`/internal/v1/sessions/${userId}/epoch`)
      .set(authHeader(E2E_INTERNAL_API_TOKEN))
      .then((res) => res);

  it('keeps the bumped epoch when a fill that read before the bump publishes after it', async () => {
    const { user } = await createTestUser(app);
    const held = publisher.holdNext();

    const stale = fill(user.id);
    await held.arrived;
    await epochs.bump(user.id);
    expect(await publishedEpoch(app, user.id)).toBe(1);

    held.release();
    const res = await stale;

    expect(res.status).toBe(200);
    // Answers with what is published now, not with what it read.
    expect(res.body).toEqual({ epoch: 1 });
    expect(await publishedEpoch(app, user.id)).toBe(1);
  });

  it('ends with Redis at the database epoch whatever order fills and bumps land', async () => {
    publisher.jitterMs = JITTER_MS;

    for (let round = 0; round < ROUNDS; round++) {
      const { user } = await createTestUser(app);

      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < FILLS; i++) {
        ops.push(fill(user.id).then((res) => expect(res.status).toBe(200)));
        if (i % (FILLS / BUMPS) === 0) ops.push(epochs.bump(user.id));
      }
      await Promise.all(ops);

      expect(await storedEpoch(pool, user.id)).toBe(BUMPS);
      expect(await publishedEpoch(app, user.id)).toBe(BUMPS);
    }
  });
});
