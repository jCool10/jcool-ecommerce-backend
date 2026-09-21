import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEASED_NODE_MAX, LEASED_NODE_MIN } from '@jcool/id-generator';
import { type LeaseDatabase, openLeaseDatabase } from '../setup/databases';

// The whole pool at once: every node handed out exactly once, and the 5-bit node field leaves no
// room to contend with more claimants than there are nodes.
const CLAIMANTS = LEASED_NODE_MAX - LEASED_NODE_MIN + 1;

describe('lease acquire under contention', () => {
  let leases: LeaseDatabase;

  beforeEach(async () => {
    leases = await openLeaseDatabase(undefined, CLAIMANTS);
  });

  afterEach(() => leases.close());

  it('hands every concurrent claimant a node of its own', async () => {
    const grants = await Promise.all(
      Array.from({ length: CLAIMANTS }, (_, i) =>
        leases.store.acquire({ holder: `claimant-${i}`, ttlMs: 60_000, quarantineMs: 0 }),
      ),
    );

    const nodeIds = grants.map((grant) => grant?.nodeId);
    expect(nodeIds).not.toContain(undefined);
    expect(new Set(nodeIds).size).toBe(CLAIMANTS);

    const { rows } = await leases.pool.query<{ holders: number }>(
      'SELECT count(DISTINCT holder)::int AS holders FROM node_leases WHERE lease_until > now()',
    );
    expect(rows[0]?.holders).toBe(CLAIMANTS);
  });
});
