import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EPOCH_MS, LAYOUT_VERSION, bucketForEmail, encode, identityKeyFingerprint } from '@jcool/id-codec';
import type { DrizzleDB } from '../../../database';
import * as schema from '../../../database/schema';
import { normalizeEmail } from '@jcool/kernel';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
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
  /** Rows returned by the pin's insert: non-empty means this boot won the first-boot race. */
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
  const db = {
    insert: () => ({ values }),
    // Told apart by table, not call order, so reordering the two checks does not silently swap which
    // fake answers which query.
    select: () => ({
      from: (table: unknown) =>
        table === identityKeyPin ? { where: pinRow } : { orderBy: () => ({ limit: userRow }) },
    }),
  };
  return { db: db as unknown as DrizzleDB, values };
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

const verifier = (db: DrizzleDB, pinBootstrap = true): IdentityBucketKeyVerifier =>
  new IdentityBucketKeyVerifier(
    db,
    fakeConfigService({ 'identity.bucketKey': KEY, 'identity.pinBootstrap': pinBootstrap }),
    fakePinoLogger(),
  );

describe('IdentityBucketKeyVerifier', () => {
  afterEach(() => {
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

    it('proceeds without rewriting a pin that matches the running key', async () => {
      const { db, values } = fakeDb({ pinRow: pinnedUnder(KEY) });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
      expect(values).not.toHaveBeenCalled();
    });

    // Bootstrap off only stops this boot writing a pin; a pin copied in with the data is still compared.
    it('refuses to boot on a pin of a different key, even with bootstrap off', async () => {
      const { db } = fakeDb({ pinRow: pinnedUnder(OTHER_KEY) });

      await expect(verifier(db, false).onApplicationBootstrap()).rejects.toThrow(/does not match the key/);
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

  describe('row canary', () => {
    it('proceeds when the newest user routes to the bucket its email hashes to', async () => {
      const id = idInBucket(bucketForEmail(EMAIL, KEY));
      const { db } = fakeDb({ userRow: () => Promise.resolve([{ id, email: EMAIL }]) });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });

    // Read back through the real schema: a column that threw on such a row would land in the
    // unreachable-database catch and let the boot through.
    it('refuses to boot, pinning nothing, on a user id that carries no routing bucket', async () => {
      const ids = ['4194303', '1', '0', '-7'];

      const outcomes = await Promise.all(
        ids.map(async (id) => {
          const { db, query } = drizzleOverPgStub(id);
          const refusal = await verifier(db)
            .onApplicationBootstrap()
            .then(
              () => 'started',
              (error: unknown) => (error as Error).message,
            );
          return { id, refusal, pinned: query.mock.calls.some(([{ text }]) => text.startsWith('insert')) };
        }),
      );

      expect(outcomes).toEqual(
        ids.map((id) => ({ id, refusal: expect.stringMatching(/no routing bucket/) as unknown, pinned: false })),
      );
    });

    // An unread table proves nothing about the key, so the pin must wait for a boot that can read it.
    it('starts when the users table cannot be read, without pinning the key', async () => {
      const { db, values } = fakeDb({ userRow: unreachable });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
      expect(values).not.toHaveBeenCalled();
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
