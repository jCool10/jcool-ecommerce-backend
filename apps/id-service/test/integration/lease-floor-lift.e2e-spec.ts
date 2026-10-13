import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEASED_NODE_MAX, LEASED_NODE_MIN } from '@jcool/id-generator';
import { LeaseKeyspaceUninitializedError } from '../../src/lease/etcd-lease-store';
import { liftFloors } from '../../src/lease/lift-floors';
import { TestKeyspace } from '../setup/keyspaces';

const CLAIM = { holder: 'claimant', ttlMs: 60_000 };

describe('lifting the floors of a keyspace', () => {
  let keyspace: TestKeyspace;

  // Not initialized: what a fresh, wiped or recreated etcd looks like.
  beforeEach(async () => {
    keyspace = await TestKeyspace.open(`/e2e/${randomUUID()}/`);
  });

  afterEach(() => keyspace.close());

  const lift = (nowMs: number, onlyIfUninitialized = false) =>
    liftFloors(keyspace.etcd, { keyPrefix: keyspace.prefix, requestTimeoutMs: 2_000, nowMs, onlyIfUninitialized });

  it('refuses every claim until the floors are lifted', async () => {
    await expect(keyspace.store().acquire(CLAIM)).rejects.toThrow(LeaseKeyspaceUninitializedError);

    await lift(Date.now());

    expect(await keyspace.store().acquire(CLAIM)).not.toBeNull();
  });

  it('raises every floor to the given instant, and never lowers one', async () => {
    const nowMs = Date.now();
    await keyspace.setFloor(LEASED_NODE_MIN, nowMs + 5_000);

    await expect(lift(nowMs)).resolves.toEqual({ kind: 'lifted', floorMs: nowMs });

    expect(await keyspace.floor(LEASED_NODE_MIN)).toBe(nowMs + 5_000);
    expect(await keyspace.floor(LEASED_NODE_MIN + 1)).toBe(nowMs);
    expect(await keyspace.floor(LEASED_NODE_MAX)).toBe(nowMs);
  });

  it('refuses to lift while any node is held', async () => {
    await lift(Date.now());
    const grant = await keyspace.store().acquire(CLAIM);

    await expect(lift(Date.now())).rejects.toThrow(new RegExp(`nodes still held \\(${grant?.nodeId}\\)`));
  });

  it('leaves an initialized keyspace alone when asked to lift only an uninitialized one', async () => {
    const firstMs = Date.now() - 60_000;
    await lift(firstMs);
    await keyspace.store().acquire(CLAIM);

    await expect(lift(Date.now(), true)).resolves.toEqual({ kind: 'already_initialized' });
    expect(await keyspace.floor(LEASED_NODE_MAX)).toBe(firstMs);
  });
});
