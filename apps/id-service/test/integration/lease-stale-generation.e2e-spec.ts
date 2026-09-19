import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaseGrant } from '@jcool/id-generator';
import { holdAllNodesExcept, type LeaseDatabase, openLeaseDatabase } from '../setup/databases';

const HOLDER = 'replica-a/host/1';
const TTL_MS = 60_000;

describe('a lease that changed hands', () => {
  let leases: LeaseDatabase;
  let stale: LeaseGrant;
  let current: LeaseGrant;

  beforeEach(async () => {
    leases = await openLeaseDatabase();
    const first = await leases.store.acquire({ holder: HOLDER, ttlMs: TTL_MS, quarantineMs: 0 });
    if (first === null) throw new Error('fresh pool had no node');
    stale = first;
    // The first holder's lease runs out and the node is claimed again, by a holder with the same name.
    await leases.pool.query(`UPDATE node_leases SET lease_until = now() - interval '1 second' WHERE node_id = $1`, [
      stale.nodeId,
    ]);
    await holdAllNodesExcept(leases.pool, stale.nodeId);
    const second = await leases.store.acquire({ holder: HOLDER, ttlMs: TTL_MS, quarantineMs: 0 });
    if (second === null) throw new Error('expired node was not reclaimed');
    current = second;
  });

  afterEach(() => leases.close());

  it('is recognised by generation, not by holder name', () => {
    expect(current.nodeId).toBe(stale.nodeId);
    expect(current.generation).toBe(stale.generation + 1);
  });

  it('refuses renewal under the old generation and leaves the new lease alone', async () => {
    const renewed = await leases.store.renew({ ...stale, holder: HOLDER, ttlMs: TTL_MS, lastMs: Date.now() });
    expect(renewed).toBeNull();

    const { rows } = await leases.pool.query<{ generation: string; max_ts_ms: string | null }>(
      'SELECT generation, max_ts_ms FROM node_leases WHERE node_id = $1',
      [stale.nodeId],
    );
    expect(rows[0]).toEqual({ generation: String(current.generation), max_ts_ms: null });
  });

  it('answers a renewal under the current generation with the lease end it wrote', async () => {
    const leaseUntilMs = await leases.store.renew({ ...current, holder: HOLDER, ttlMs: TTL_MS, lastMs: Date.now() });

    const { rows } = await leases.pool.query<{ until_ms: string }>(
      'SELECT (extract(epoch FROM lease_until) * 1000)::bigint AS until_ms FROM node_leases WHERE node_id = $1',
      [current.nodeId],
    );
    expect(leaseUntilMs).toBe(Number(rows[0]?.until_ms));
  });

  it('ignores a release under the old generation', async () => {
    await leases.store.release({ ...stale, holder: HOLDER, lastMs: Date.now() });

    const { rows } = await leases.pool.query<{ holder: string | null; live: boolean }>(
      'SELECT holder, lease_until > now() AS live FROM node_leases WHERE node_id = $1',
      [stale.nodeId],
    );
    expect(rows[0]).toEqual({ holder: HOLDER, live: true });
  });
});
