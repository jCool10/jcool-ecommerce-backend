import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeLease } from '@jcool/id-generator';
import { TEST_LEASE_CONFIG } from '../../src/lease/testing/test-node-lease';
import { TestKeyspace } from '../setup/keyspaces';

// Same host, same pid, same replica id: two processes that compute an identical holder string.
const SHARED_HOLDER = 'replica-a/host/1';

describe('two live processes that compute the same holder string', () => {
  let keyspace: TestKeyspace;

  beforeEach(async () => {
    keyspace = await TestKeyspace.open();
    await keyspace.holdAllNodesExcept(10, 11);
  });

  afterEach(() => keyspace.close());

  function process(): NodeLease {
    return NodeLease.create({ ...TEST_LEASE_CONFIG, holder: SHARED_HOLDER, store: keyspace.store() });
  }

  it('never lets both mint under one node id', async () => {
    const first = process();
    const second = process();

    await first.acquire();
    await second.acquire();

    expect(first.nodeId).toBeDefined();
    expect(second.nodeId).toBeDefined();
    expect(second.nodeId).not.toBe(first.nodeId);

    const ids = new Set<string>();
    for (const lease of [first, second]) {
      for (let i = 0; i < 2_000; i++) ids.add(lease.generate());
    }
    expect(ids.size).toBe(4_000);
  });
});
