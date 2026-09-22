import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EPOCH_MS, LAYOUT_VERSION, bucketForEmail, encode, identityKeyFingerprint } from '@jcool/id-codec';
import type { DrizzleDB } from '../../../database';
import * as schema from '../../../database/schema';
import { normalizeEmail } from '@jcool/kernel';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { type FakePinoLogger, fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { IdentityBucketKeyVerifier } from './identity-bucket-key.verifier';
import { identityKeyPin } from './schema/user.schema';

const KEY = 'verifier-spec-identity-bucket-key-not-a-real-secret';
const OTHER_KEY = 'a-different-identity-bucket-key-not-a-real-secret';
const EMAIL = normalizeEmail('canary@test.local');

const idInBucket = (bucket: number): string => encode({ tsMs: EPOCH_MS + 1, bucket, nodeId: 0, sequence: 0 });

const pinnedUnder =
  (key: string, layoutVersion = LAYOUT_VERSION) =>
  () =>
    Promise.resolve([{ fingerprint: identityKeyFingerprint(key), layoutVersion }]);

const unreachable = (): Promise<never> => Promise.reject(new Error('connection terminated'));

interface FakeDbOptions {
  /** Rows returned by the pin's insert — non-empty means this boot won the first-boot race. */
  pinInsert?: () => Promise<{ fingerprint: string }[]>;
  pinRow?: () => Promise<{ fingerprint: string; layoutVersion: number }[]>;
  userRow?: () => Promise<{ id: string; email: string }[]>;
}

function fakeDb(options: FakeDbOptions = {}) {
  const {
    pinInsert = () => Promise.resolve([]),
    pinRow = () => Promise.resolve([]),
    userRow = () => Promise.resolve([]),
  } = options;
  const values = vi.fn().mockReturnValue({
    onConflictDoNothing: () => ({ returning: pinInsert }),
  });
  const users = vi.fn(userRow);
  const db = {
    insert: () => ({ values }),
    // Told apart by table, not call order, so reordering the two checks does not silently swap which
    // fake answers which query.
    select: () => ({
      from: (table: unknown) => (table === identityKeyPin ? { where: pinRow } : { orderBy: () => ({ limit: users }) }),
    }),
  };
  return { db: db as unknown as DrizzleDB, values, users };
}

/**
 * Real drizzle over a pg client stub answering as node-postgres does in drizzle's array row mode, int8
 * as a decimal string, so the schema's column mapping runs on every row read back.
 */
function drizzleOverPgStub(newestUserId: string) {
  const query = vi.fn(({ text }: { text: string }) => {
    if (text.includes('from "users"')) return Promise.resolve({ rows: [[newestUserId, EMAIL]] });
    if (text.startsWith('insert into "identity_key_pin"')) {
      return Promise.resolve({ rows: [[identityKeyFingerprint(KEY)]] });
    }
    return Promise.resolve({ rows: [] });
  });
  const db = drizzle({ client: { query } as unknown as Pool, schema });
  return { db: db as unknown as DrizzleDB, query };
}

const verifier = (
  db: DrizzleDB,
  key = KEY,
  pinBootstrap = true,
  logger: FakePinoLogger = fakePinoLogger(),
): IdentityBucketKeyVerifier =>
  new IdentityBucketKeyVerifier(
    db,
    fakeConfigService({ 'identity.bucketKey': key, 'identity.pinBootstrap': pinBootstrap }),
    logger,
  );

describe('IdentityBucketKeyVerifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('key pin', () => {
    it('persists the current key fingerprint on the first boot against a database', async () => {
      const fingerprint = identityKeyFingerprint(KEY);
      const { db, values } = fakeDb({ pinInsert: () => Promise.resolve([{ fingerprint }]) });

      // That the boot succeeds and lands the row is asserted end to end; the singleton `id: 1` the
      // pin is written under is not.
      await verifier(db).onApplicationBootstrap();

      expect(values).toHaveBeenCalledWith({ id: 1, fingerprint, layoutVersion: LAYOUT_VERSION });
    });

    it('proceeds when the pinned fingerprint is the running key, without writing it again', async () => {
      const { db, values } = fakeDb({ pinRow: pinnedUnder(KEY) });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
      expect(values).not.toHaveBeenCalled();
    });

    it('refuses to boot when the pinned fingerprint is a different key', async () => {
      const { db } = fakeDb({ pinRow: pinnedUnder(OTHER_KEY) });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/does not match the key/);
    });

    // The key can be right while the layout is not: same secret, different epoch or field widths,
    // and every stored id then decodes to a different bucket.
    it('refuses to boot when the pinned layout is not the running one', async () => {
      const { db } = fakeDb({ pinRow: pinnedUnder(KEY, LAYOUT_VERSION + 1) });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/id layout does not match/);
    });

    // The loser of two concurrent first boots is held to the winner's pin.
    it('refuses to boot when a concurrent first boot pinned a different key', async () => {
      const pinRow = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ fingerprint: identityKeyFingerprint(OTHER_KEY), layoutVersion: LAYOUT_VERSION }]);
      const { db } = fakeDb({ pinRow });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/does not match the key/);
      expect(pinRow).toHaveBeenCalledTimes(2);
    });

    // Fail open: no id is minted while the database is down, so refusing to start only extends the outage.
    it('starts when the database cannot be reached', async () => {
      const { db } = fakeDb({ pinRow: unreachable, pinInsert: unreachable, userRow: unreachable });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('starts when the pin can be read but not written', async () => {
      const { db } = fakeDb({ pinInsert: unreachable });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  // The pin is copied in from the database being migrated, never minted by a dark boot.
  describe('key pin with bootstrap off', () => {
    it('writes no pin on an empty database, and starts', async () => {
      const { db, values } = fakeDb();

      await expect(verifier(db, KEY, false).onApplicationBootstrap()).resolves.toBeUndefined();
      expect(values).not.toHaveBeenCalled();
    });

    it('proceeds when the pinned fingerprint is the running key', async () => {
      const { db, values } = fakeDb({ pinRow: pinnedUnder(KEY) });

      await expect(verifier(db, KEY, false).onApplicationBootstrap()).resolves.toBeUndefined();
      expect(values).not.toHaveBeenCalled();
    });

    it('still refuses to boot when the pinned fingerprint is a different key', async () => {
      const { db } = fakeDb({ pinRow: pinnedUnder(OTHER_KEY) });

      await expect(verifier(db, KEY, false).onApplicationBootstrap()).rejects.toThrow(/does not match the key/);
    });

    it('starts when the pin cannot be read', async () => {
      const { db, values } = fakeDb({ pinRow: unreachable });

      await expect(verifier(db, KEY, false).onApplicationBootstrap()).resolves.toBeUndefined();
      expect(values).not.toHaveBeenCalled();
    });
  });

  describe('row canary', () => {
    it('proceeds when the newest user routes to the bucket its email hashes to', async () => {
      const id = idInBucket(bucketForEmail(EMAIL, KEY));
      const { db } = fakeDb({ userRow: () => Promise.resolve([{ id, email: EMAIL }]) });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('refuses to boot when the newest user routes to a different bucket', async () => {
      const id = idInBucket(bucketForEmail(EMAIL, OTHER_KEY));
      const { db } = fakeDb({ userRow: () => Promise.resolve([{ id, email: EMAIL }]) });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/does not route to the bucket/);
    });

    // Read back through the real schema: a column that threw on such a row would land in the
    // unreachable-database catch and let the boot through.
    it.each(['4194303', '1', '0', '-7'])(
      'refuses to boot on a user id that carries no routing bucket (%s)',
      async (id) => {
        const { db, query } = drizzleOverPgStub(id);
        const warn = vi.fn();

        await expect(verifier(db, KEY, true, fakePinoLogger({ warn })).onApplicationBootstrap()).rejects.toThrow(
          /no routing bucket/,
        );
        expect(warn).not.toHaveBeenCalledWith(expect.anything(), 'identity routing canary not checked');
        expect(query).not.toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringMatching(/^insert/) as unknown }),
          expect.anything(),
        );
      },
    );

    // Nothing to compare against — which is exactly why the pin, not this, is the primary check.
    it('starts on an empty database', async () => {
      const { db } = fakeDb();

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });

    // An unread table proves nothing about the key, so the pin must wait for a boot that can read it.
    it('starts when the users table cannot be read, without pinning the key', async () => {
      const { db, values } = fakeDb({ userRow: unreachable });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
      expect(values).not.toHaveBeenCalled();
    });
  });

  describe('check order', () => {
    // The pin is what every later boot is held to, so it must never record a key the rows already disprove.
    it('does not pin a key the newest row has already disproved', async () => {
      const id = idInBucket(bucketForEmail(EMAIL, OTHER_KEY));
      const { db, values } = fakeDb({ userRow: () => Promise.resolve([{ id, email: EMAIL }]) });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/does not route to the bucket/);
      expect(values).not.toHaveBeenCalled();
    });

    // A layout that moves the bucket field makes every stored id decode to some other bucket, which
    // the canary alone would blame on the key.
    it('reports a changed layout on a populated database as the layout, not the key', async () => {
      const id = idInBucket(bucketForEmail(EMAIL, OTHER_KEY));
      const { db, users } = fakeDb({
        pinRow: pinnedUnder(KEY, LAYOUT_VERSION + 1),
        userRow: () => Promise.resolve([{ id, email: EMAIL }]),
      });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/id layout does not match/);
      expect(users).not.toHaveBeenCalled();
    });
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
