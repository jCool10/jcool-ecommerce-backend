import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestKeyspace } from '../setup/keyspaces';

const CLAIMED_NODE = 12;
const FREE_NODE = 20;
const CLAIM = { holder: 'replica-a/host/1', ttlMs: 60_000 };

describe('acquire after a claim commits but its caller never learns the outcome', () => {
  let keyspace: TestKeyspace;

  beforeEach(async () => {
    keyspace = await TestKeyspace.open();
    // Both free and never leased, so the claim lands on the lower one and a second claim on the other.
    await keyspace.holdAllNodesExcept(CLAIMED_NODE, FREE_NODE);
  });

  afterEach(() => keyspace.close());

  it('re-adopts the node its own timed-out claim already committed, leaving the free node alone', async () => {
    const store = keyspace.store();
    const txn = keyspace.etcd.kv.txn.bind(keyspace.etcd.kv);
    vi.spyOn(keyspace.etcd.kv, 'txn').mockImplementationOnce(async (...args) => {
      await txn(...args);
      throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded');
    });

    await expect(store.acquire(CLAIM)).rejects.toThrow(/DEADLINE_EXCEEDED/);
    vi.restoreAllMocks();
    const committed = await keyspace.owner(CLAIMED_NODE);
    if (committed === undefined) throw new Error('the claim did not commit');

    const grant = await store.acquire(CLAIM);

    expect(grant).toMatchObject({ nodeId: CLAIMED_NODE, generation: Number(committed.create_revision), floorMs: null });
    expect(grant?.leaseUntilMs).toBe(await keyspace.floor(CLAIMED_NODE));
    expect((await keyspace.owner(CLAIMED_NODE))?.lease).toBe(committed.lease);
    expect(await keyspace.owner(FREE_NODE)).toBeUndefined();
  });

  it('claims afresh once the lease its lost claim committed under has run out', async () => {
    const store = keyspace.store();
    const txn = keyspace.etcd.kv.txn.bind(keyspace.etcd.kv);
    vi.spyOn(keyspace.etcd.kv, 'txn').mockImplementationOnce(async (...args) => {
      await txn(...args);
      throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded');
    });
    await expect(store.acquire(CLAIM)).rejects.toThrow(/DEADLINE_EXCEEDED/);
    vi.restoreAllMocks();
    const lost = await keyspace.owner(CLAIMED_NODE);
    await keyspace.etcd.leaseClient.leaseRevoke({ ID: lost?.lease });
    await keyspace.holdAllNodesExcept(CLAIMED_NODE);

    const grant = await store.acquire(CLAIM);

    expect(grant?.nodeId).toBe(CLAIMED_NODE);
    expect((await keyspace.owner(CLAIMED_NODE))?.lease).not.toBe(lost?.lease);
    // Revoked early here, so the ceiling the lost claim reserved still lies ahead; the claim starts above it.
    expect(grant?.floorMs).toBeGreaterThan(Date.now());
  });
});
