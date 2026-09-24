import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { FakeSessionEpochPublisher } from '../../testing/session-epoch.double';
import type { EpochChange, EpochChangeCursor, SessionEpochChangesPort } from '../ports';
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

describe('SessionEpochReconciler', () => {
  let users: FakeUsers;
  let publisher: FakeSessionEpochPublisher;
  let reconciler: SessionEpochReconciler;

  const reconcilerWithAccessTtl = (ttl: string): SessionEpochReconciler =>
    new SessionEpochReconciler(users, publisher, fakePinoLogger(), fakeConfigService({ 'auth.jwtAccessTtl': ttl }));

  beforeEach(() => {
    users = new FakeUsers();
    publisher = new FakeSessionEpochPublisher();
    reconciler = reconcilerWithAccessTtl('5m');
  });

  it('looks back fifteen minutes on its first pass', async () => {
    users.changed('recent', 2, ago(14 * MINUTE));
    users.changed('stale', 5, ago(20 * MINUTE));

    await reconciler.reconcileOnce(NOW);

    expect(publisher.published).toEqual(new Map([['recent', 2]]));
  });

  // A lost publish matters for as long as a token issued before that bump can still be presented.
  it('looks back as far as an access token lives, when that is longer', async () => {
    reconciler = reconcilerWithAccessTtl('1h');
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

  it('republishes a change from a failed pass even after the overlap has passed', async () => {
    users.changed('u1', 3, ago(SECOND));
    publisher.failFor.add('u1');
    await reconciler.reconcileOnce(NOW);
    expect(publisher.published.has('u1')).toBe(false);

    publisher.failFor.clear();
    await reconciler.reconcileOnce(new Date(NOW.getTime() + 10 * MINUTE));

    expect(publisher.published.get('u1')).toBe(3);
  });

  it('stops a pass at the first failed publish', async () => {
    users.changed('u1', 1, ago(2 * SECOND));
    users.changed('u2', 1, ago(SECOND));
    publisher.failFor.add('u1');

    await reconciler.reconcileOnce(NOW);

    expect(publisher.published.has('u2')).toBe(false);
  });
});
