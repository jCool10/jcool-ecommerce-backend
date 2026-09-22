import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { EpochChange, EpochChangeCursor, SessionEpochChangesPort, SessionEpochPublisherPort } from '../ports';
import { SessionEpochReconciler } from './session-epoch-reconciler';

const NOW = new Date('2026-09-19T10:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

// ISO strings order like the timestamps they hold, which is all the keyset needs from them.
class FakeUsers implements SessionEpochChangesPort {
  readonly rows: EpochChange[] = [];
  readonly pages: Array<{ since: Date; after: EpochChangeCursor | null }> = [];

  changed(userId: string, epoch: number, at: Date): void {
    this.rows.push({ userId, epoch, updatedAt: at.toISOString() });
  }

  listChanges(since: Date, after: EpochChangeCursor | null, limit: number): Promise<EpochChange[]> {
    this.pages.push({ since, after });
    const key = (c: EpochChangeCursor): string => `${c.updatedAt}|${c.userId}`;
    return Promise.resolve(
      this.rows
        .filter((row) => (after ? key(row) > key(after) : row.updatedAt >= since.toISOString()))
        .sort((a, b) => key(a).localeCompare(key(b)))
        .slice(0, limit),
    );
  }
}

class FakePublisher implements SessionEpochPublisherPort {
  readonly published = new Map<string, number>();
  failFor = new Set<string>();

  publish(userId: string, epoch: number): Promise<number> {
    if (this.failFor.has(userId)) return Promise.reject(new Error('Connection is closed.'));
    const next = Math.max(this.published.get(userId) ?? 0, epoch);
    this.published.set(userId, next);
    return Promise.resolve(next);
  }
}

describe('SessionEpochReconciler', () => {
  let users: FakeUsers;
  let publisher: FakePublisher;
  let reconciler: SessionEpochReconciler;

  beforeEach(() => {
    users = new FakeUsers();
    publisher = new FakePublisher();
    reconciler = new SessionEpochReconciler(
      users,
      publisher,
      fakePinoLogger(),
      fakeConfigService({ 'auth.jwtAccessTtl': '5m' }),
    );
  });

  it('looks back fifteen minutes on its first pass', async () => {
    users.changed('recent', 2, ago(14 * MINUTE));
    users.changed('stale', 5, ago(20 * MINUTE));

    await reconciler.reconcileOnce(NOW);

    expect(publisher.published).toEqual(new Map([['recent', 2]]));
  });

  // A lost publish matters for as long as a token issued before that bump can still be presented.
  it('looks back as far as an access token lives, when that is longer', async () => {
    reconciler = new SessionEpochReconciler(
      users,
      publisher,
      fakePinoLogger(),
      fakeConfigService({ 'auth.jwtAccessTtl': '1h' }),
    );
    users.changed('within-ttl', 2, ago(50 * MINUTE));
    users.changed('expired', 5, ago(70 * MINUTE));

    await reconciler.reconcileOnce(NOW);

    expect(publisher.published).toEqual(new Map([['within-ttl', 2]]));
  });

  it('starts each later pass thirty seconds before the previous one started', async () => {
    await reconciler.reconcileOnce(NOW);
    const next = new Date(NOW.getTime() + 5 * SECOND);

    await reconciler.reconcileOnce(next);

    expect(users.pages.at(-1)).toEqual({ since: ago(30 * SECOND), after: null });
  });

  it('pages through every change without dropping or repeating a row', async () => {
    for (let i = 0; i < 1_201; i++) {
      // Shared timestamps, so the id half of the cursor is what separates rows.
      users.changed(`u${String(i).padStart(4, '0')}`, i, ago(MINUTE - Math.floor(i / 7)));
    }

    await reconciler.reconcileOnce(NOW);

    expect(publisher.published.size).toBe(1_201);
    expect(users.pages.map((page) => page.after === null)).toEqual([true, false, false]);
  });

  it('keeps its place after a failed publish, so an outage longer than the overlap is still repaired', async () => {
    users.changed('u1', 3, ago(SECOND));
    publisher.failFor.add('u1');
    await reconciler.reconcileOnce(NOW);
    expect(publisher.published.has('u1')).toBe(false);

    publisher.failFor.clear();
    await reconciler.reconcileOnce(new Date(NOW.getTime() + 10 * MINUTE));

    expect(publisher.published.get('u1')).toBe(3);
  });

  it('stops a pass at the first failed publish rather than retrying every row against a dead Redis', async () => {
    users.changed('u1', 1, ago(2 * SECOND));
    users.changed('u2', 1, ago(SECOND));
    publisher.failFor.add('u1');

    await reconciler.reconcileOnce(NOW);

    expect(publisher.published.has('u2')).toBe(false);
  });
});
