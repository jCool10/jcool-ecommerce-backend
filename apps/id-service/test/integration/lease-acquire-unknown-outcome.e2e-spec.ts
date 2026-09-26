import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdAllNodesExcept, type LeaseDatabase, openLeaseDatabase } from '../setup/databases';

const HOLDER = 'replica-a/host/1';
const CLAIMED_NODE = 12;
const FREE_NODE = 20;
const TTL_MS = 60_000;

describe('acquire after a claim commits but its caller never learns the outcome', () => {
  let leases: LeaseDatabase;

  beforeEach(async () => {
    leases = await openLeaseDatabase();
    // Everything but these two is out of the running, so a wrong claim is unambiguous: it can only
    // ever be FREE_NODE.
    await holdAllNodesExcept(leases.pool, CLAIMED_NODE, FREE_NODE);
  });

  afterEach(() => leases.close());

  it('re-adopts the node its own timed-out claim already committed, leaving the free node alone', async () => {
    // Stands in for the claim UPDATE having committed on the server after this holder's client gave
    // up on the statement (a query_timeout): the row looks exactly like a successful claim, but the
    // caller that ran it never saw the grant and is about to retry.
    const priorLeaseEnd = new Date(Date.now() - 5 * 60_000);
    await leases.pool.query(
      `UPDATE node_leases
       SET holder = $2, generation = generation + 1, lease_until = now() + interval '1 minute',
           prior_lease_until = $3, acquired_at = now(), renewed_at = now()
       WHERE node_id = $1`,
      [CLAIMED_NODE, HOLDER, priorLeaseEnd],
    );
    const before = await leases.pool.query<{ generation: string }>(
      'SELECT generation FROM node_leases WHERE node_id = $1',
      [CLAIMED_NODE],
    );

    const grant = await leases.store.acquire({ holder: HOLDER, ttlMs: TTL_MS, quarantineMs: 0 });

    expect(grant).toMatchObject({
      nodeId: CLAIMED_NODE,
      generation: Number(before.rows[0]?.generation),
      prevUntilMs: priorLeaseEnd.getTime(),
    });

    const { rows } = await leases.pool.query<{ node_id: number; holder: string | null }>(
      'SELECT node_id, holder FROM node_leases WHERE node_id = ANY($1::smallint[])',
      [[CLAIMED_NODE, FREE_NODE]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { node_id: CLAIMED_NODE, holder: HOLDER },
        { node_id: FREE_NODE, holder: null },
      ]),
    );
  });
});
