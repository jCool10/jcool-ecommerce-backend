import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEASED_NODE_MAX, LEASED_NODE_MIN } from '@jcool/id-generator';
import { TestKeyspace } from '../setup/keyspaces';

// The whole pool at once: every node handed out exactly once, and the 8-bit node field leaves no
// room to contend with more claimants than there are nodes.
const CLAIMANTS = LEASED_NODE_MAX - LEASED_NODE_MIN + 1;

describe('lease acquire under contention', () => {
  let keyspace: TestKeyspace;

  beforeEach(async () => {
    keyspace = await TestKeyspace.open();
  });

  afterEach(() => keyspace.close());

  it('hands every concurrent claimant a node of its own', async () => {
    const grants = await Promise.all(
      Array.from({ length: CLAIMANTS }, (_, i) => keyspace.store().acquire({ holder: `claimant-${i}`, ttlMs: 60_000 })),
    );

    const nodeIds = grants.map((grant) => grant?.nodeId);
    expect(nodeIds).not.toContain(undefined);
    expect(new Set(nodeIds).size).toBe(CLAIMANTS);

    const owners = await keyspace.owners();
    expect(new Set(owners.map((owner) => owner.lease)).size).toBe(CLAIMANTS);
  });
});
