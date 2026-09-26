import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdAllNodesExcept, type LeaseDatabase, openLeaseDatabase } from '../setup/databases';

describe('lease acquire order', () => {
  let leases: LeaseDatabase;

  beforeEach(async () => {
    leases = await openLeaseDatabase();
  });

  afterEach(() => leases.close());

  // The longest-idle node is the one whose previous holder is least likely to still be minting. Each
  // probe uses its own holder: an acquire re-adopts any unexpired lease already held under the same
  // holder id, so reusing one across probes would just hand the first one back every time.
  it('claims the node that expired longest ago, the lowest id on a tie', async () => {
    await holdAllNodesExcept(leases.pool, 5, 7, 9);
    await leases.pool.query(`
      UPDATE node_leases
      SET lease_until = CASE node_id WHEN 9 THEN now() - interval '1 minute' ELSE timestamptz '2020-01-01' END
      WHERE node_id IN (5, 7, 9)
    `);

    const order = [];
    for (let i = 0; i < 4; i += 1) {
      order.push(
        (await leases.store.acquire({ holder: `claimant-${i}`, ttlMs: 60_000, quarantineMs: 0 }))?.nodeId ?? null,
      );
    }

    expect(order).toEqual([5, 7, 9, null]);
  });
});
