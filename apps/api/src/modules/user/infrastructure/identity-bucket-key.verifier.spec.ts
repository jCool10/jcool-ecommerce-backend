import { afterEach, describe, expect, it, vi } from 'vitest';
import { bucketForEmail, encode, identityKeyFingerprint } from '@shared/identity';
import type { DrizzleDB } from '@shared/infrastructure/database';
import { normalizeEmail } from '@shared/kernel';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import { IdentityBucketKeyVerifier } from './identity-bucket-key.verifier';
import { identityKeyPin } from './schema/user.schema';

const KEY = 'verifier-spec-identity-bucket-key-not-a-real-secret';
const OTHER_KEY = 'a-different-identity-bucket-key-not-a-real-secret';
const EMAIL = normalizeEmail('canary@test.local');

const idInBucket = (bucket: number): string => encode({ tsMs: 1, bucket, nodeId: 0, sequence: 0, random: 0 });

const unreachable = (): Promise<never> => Promise.reject(new Error('connection terminated'));

interface FakeDbOptions {
  /** Rows returned by the pin's insert — non-empty means this boot won the first-boot race. */
  pinInsert?: () => Promise<{ fingerprint: string }[]>;
  pinRow?: () => Promise<{ fingerprint: string }[]>;
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

const verifier = (db: DrizzleDB, key = KEY): IdentityBucketKeyVerifier =>
  new IdentityBucketKeyVerifier(db, fakeConfigService({ 'identity.bucketKey': key }), fakePinoLogger());

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

      expect(values).toHaveBeenCalledWith({ id: 1, fingerprint });
    });

    it('proceeds when the pinned fingerprint is the running key', async () => {
      const { db } = fakeDb({ pinRow: () => Promise.resolve([{ fingerprint: identityKeyFingerprint(KEY) }]) });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('refuses to boot when the pinned fingerprint is a different key', async () => {
      const { db } = fakeDb({ pinRow: () => Promise.resolve([{ fingerprint: identityKeyFingerprint(OTHER_KEY) }]) });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/does not match the key/);
    });

    // Fail open: no id is minted while the database is down, so refusing to start only extends the outage.
    it('starts when the database cannot be reached', async () => {
      const { db } = fakeDb({ pinInsert: unreachable, userRow: unreachable });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
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

    it('refuses to boot on a user id that is not a UUIDv8', async () => {
      const { db } = fakeDb({
        userRow: () => Promise.resolve([{ id: '01920000-0000-7000-8000-000000000001', email: EMAIL }]),
      });

      await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/no routing bucket/);
    });

    // Nothing to compare against — which is exactly why the pin, not this, is the primary check.
    it('starts on an empty database', async () => {
      const { db } = fakeDb();

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('starts when the users table cannot be read', async () => {
      const { db } = fakeDb({ userRow: unreachable });

      await expect(verifier(db).onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  // The pin is what every later boot is held to, so it must never record a key the rows already disprove.
  it('does not pin a key the newest row has already disproved', async () => {
    const id = idInBucket(bucketForEmail(EMAIL, OTHER_KEY));
    const { db, values } = fakeDb({ userRow: () => Promise.resolve([{ id, email: EMAIL }]) });

    await expect(verifier(db).onApplicationBootstrap()).rejects.toThrow(/does not route to the bucket/);
    expect(values).not.toHaveBeenCalled();
  });

  it('starts when the database accepts a query but never answers', async () => {
    vi.useFakeTimers();
    const never = (): Promise<never> => new Promise(() => undefined);
    const { db } = fakeDb({ pinInsert: never, userRow: never });

    const booting = verifier(db).onApplicationBootstrap();
    await vi.runAllTimersAsync();

    await expect(booting).resolves.toBeUndefined();
  });
});
