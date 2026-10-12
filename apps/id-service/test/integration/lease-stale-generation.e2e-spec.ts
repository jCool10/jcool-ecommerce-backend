import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaseGrant } from '@jcool/id-generator';
import { TestKeyspace } from '../setup/keyspaces';

const HOLDER = 'replica-a/host/1';
const TTL_MS = 60_000;

describe('a lease that changed hands', () => {
  let keyspace: TestKeyspace;
  let stale: LeaseGrant;
  let current: LeaseGrant;

  beforeEach(async () => {
    keyspace = await TestKeyspace.open();
    const first = await keyspace.store().acquire({ holder: HOLDER, ttlMs: TTL_MS });
    if (first === null) throw new Error('fresh pool had no node');
    stale = first;
    // The first holder's lease runs out and the node is claimed again, by a holder with the same name.
    await keyspace.expire(stale.nodeId);
    await keyspace.holdAllNodesExcept(stale.nodeId);
    const second = await keyspace.store().acquire({ holder: HOLDER, ttlMs: TTL_MS });
    if (second === null) throw new Error('expired node was not reclaimed');
    current = second;
  });

  afterEach(() => keyspace.close());

  it('is recognised by generation, not by holder name', () => {
    expect(current.nodeId).toBe(stale.nodeId);
    expect(current.generation).toBeGreaterThan(stale.generation);
  });

  it('refuses renewal under the old generation and leaves the new ceiling alone', async () => {
    const renewed = await keyspace.store().renew({ ...stale, holder: HOLDER, ttlMs: TTL_MS * 10, lastMs: Date.now() });

    expect(renewed).toBeNull();
    expect(await keyspace.floor(stale.nodeId)).toBe(current.leaseUntilMs);
  });

  it('answers a renewal under the current generation with the ceiling it wrote', async () => {
    const renewed = await keyspace.store().renew({ ...current, holder: HOLDER, ttlMs: TTL_MS, lastMs: Date.now() });

    expect(renewed).toBe(await keyspace.floor(current.nodeId));
    expect(renewed).toBeGreaterThanOrEqual(current.leaseUntilMs);
  });

  it('ignores a release under the old generation', async () => {
    await keyspace.store().release({ ...stale, holder: HOLDER, lastMs: Date.now() });

    const owner = await keyspace.owner(stale.nodeId);
    expect(Number(owner?.create_revision)).toBe(current.generation);
    expect(await keyspace.floor(stale.nodeId)).toBe(current.leaseUntilMs);
  });
});
