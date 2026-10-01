import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_VERSION } from '@jcool/id-codec';
import type { DrizzleDB } from '../../../database';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { IdentityLayoutPinVerifier, identityLayoutMismatch } from './identity-layout-pin.verifier';
import { identityKeyPin } from './schema/user.schema';

const pinnedAt =
  (layoutVersion = LAYOUT_VERSION) =>
  () =>
    Promise.resolve([{ layoutVersion }]);

const unreachable = (): Promise<never> => Promise.reject(new Error('connection terminated'));

interface FakeDbOptions {
  /** Rows returned by the pin's insert: non-empty means this boot won the first-boot race. */
  pinInsert?: () => Promise<{ layoutVersion: number }[]>;
  pinRow?: () => Promise<{ layoutVersion: number }[]>;
  userRow?: () => Promise<{ id: string }[]>;
}

function fakeDb(options: FakeDbOptions = {}) {
  const {
    pinInsert = () => Promise.resolve([{ layoutVersion: LAYOUT_VERSION }]),
    pinRow = () => Promise.resolve([]),
    userRow = () => Promise.resolve([]),
  } = options;
  const values = vi.fn().mockReturnValue({
    onConflictDoNothing: () => ({ returning: pinInsert }),
  });
  const db = {
    insert: () => ({ values }),
    // Told apart by table, not call order, so reordering the reads does not silently swap which fake
    // answers which query.
    select: () => ({
      from: (table: unknown) => (table === identityKeyPin ? { where: pinRow } : { limit: userRow }),
    }),
  };
  return { db: db as unknown as DrizzleDB, values };
}

const verifier = (db: DrizzleDB, pinBootstrap = true): IdentityLayoutPinVerifier =>
  new IdentityLayoutPinVerifier(db, fakeConfigService({ 'identity.pinBootstrap': pinBootstrap }), fakePinoLogger());

describe('identityLayoutMismatch', () => {
  it('accepts the running layout', () => {
    expect(identityLayoutMismatch(LAYOUT_VERSION)).toBeNull();
  });

  it('names both layout versions when they differ', () => {
    const mismatch = identityLayoutMismatch(LAYOUT_VERSION - 1);

    expect(mismatch).toMatch(/^The id layout does not match the one this database was built with/);
    expect(mismatch).toContain(`pinned ${LAYOUT_VERSION - 1}, current ${LAYOUT_VERSION}`);
  });
});

describe('IdentityLayoutPinVerifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the running layout on the first boot against an empty database', async () => {
    const { db, values } = fakeDb();

    await verifier(db).onApplicationBootstrap();

    expect(values).toHaveBeenCalledWith({ id: 1, layoutVersion: LAYOUT_VERSION });
  });

  it('proceeds without rewriting a pin that matches the running layout', async () => {
    const { db, values } = fakeDb({ pinRow: pinnedAt() });

    await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(values).not.toHaveBeenCalled();
  });

  // Bootstrap off only stops this boot writing a pin; a pin copied in with the data is still compared.
  it('refuses to boot on a pin of another layout, even with bootstrap off', async () => {
    const { db } = fakeDb({ pinRow: pinnedAt(LAYOUT_VERSION - 1) });

    await expect(verifier(db, false).onApplicationBootstrap()).rejects.toThrow(/id layout does not match/);
  });

  it('writes nothing with bootstrap off', async () => {
    const { db, values } = fakeDb();

    await expect(verifier(db, false).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(values).not.toHaveBeenCalled();
  });

  // Those users were minted under a layout nothing recorded; pinning the running one would be a guess.
  it('does not pin a database that already holds users', async () => {
    const { db, values } = fakeDb({ userRow: () => Promise.resolve([{ id: '8591612313777883' }]) });

    await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(values).not.toHaveBeenCalled();
  });

  // The loser of two concurrent first boots is held to the winner's pin.
  it('refuses to boot when a concurrent first boot pinned another layout', async () => {
    const pinRow = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ layoutVersion: LAYOUT_VERSION - 1 }]);
    const { db } = fakeDb({ pinRow, pinInsert: () => Promise.resolve([]) });

    await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/id layout does not match/);
    expect(pinRow).toHaveBeenCalledTimes(2);
  });

  // Fail open: no id is minted while the database is down, so refusing to start only extends the outage.
  it('starts when the database cannot be reached', async () => {
    const { db } = fakeDb({ pinRow: unreachable, pinInsert: unreachable, userRow: unreachable });

    await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  // Asked to pin by a database that answered: serving on would let a first user land unpinned for good.
  it('refuses to boot when asked to pin but the users table cannot be read', async () => {
    const { db, values } = fakeDb({ userRow: unreachable });

    await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/id layout pin not written/);
    expect(values).not.toHaveBeenCalled();
  });

  it('refuses to boot when asked to pin but the pin cannot be written', async () => {
    const { db } = fakeDb({ pinInsert: unreachable });

    await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/id layout pin not written/);
  });

  it('starts when the database accepts a query but never answers', async () => {
    vi.useFakeTimers();
    const never = (): Promise<never> => new Promise(() => undefined);
    const { db } = fakeDb({ pinRow: never, pinInsert: never, userRow: never });

    const booting = verifier(db).onApplicationBootstrap();
    await vi.runAllTimersAsync();

    await expect(booting).resolves.toBeUndefined();
  });
});
