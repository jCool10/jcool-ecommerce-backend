import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestKeyspace } from '../setup/keyspaces';

describe('lease acquire order', () => {
  let keyspace: TestKeyspace;

  beforeEach(async () => {
    keyspace = await TestKeyspace.open();
  });

  afterEach(() => keyspace.close());

  // The node idle longest is the one whose floor sits furthest in the past, so its next holder mints
  // nearest the present. Never-leased nodes carry no floor and tie at the front.
  it('claims the node whose floor was written longest ago, the lowest id on a tie', async () => {
    await keyspace.holdAllNodesExcept(5, 7, 9, 11);
    await keyspace.setFloor(9, Date.now() - 60_000);
    await keyspace.setFloor(11, Date.now() - 120_000);

    const store = keyspace.store();
    const order = [];
    for (let i = 0; i < 5; i += 1) {
      order.push((await store.acquire({ holder: `claimant-${i}`, ttlMs: 60_000 }))?.nodeId ?? null);
    }

    expect(order).toEqual([5, 7, 9, 11, null]);
  });
});
