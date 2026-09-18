import type { Counter } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { decode } from '@jcool/id-codec';
import { LeaseNotHeldError } from '@jcool/id-generator';
import { FakeLeaseStore } from '../lease/testing/fake-lease-store';
import { testNodeLease } from '../lease/testing/test-node-lease';
import { MintController } from './mint.controller';

async function setup(grant = true) {
  const store = new FakeLeaseStore();
  if (grant) store.grant(7);
  const lease = testNodeLease(store);
  await lease.acquire();
  const minted = { inc: vi.fn() };
  return { controller: new MintController(lease, minted as unknown as Counter<'caller'>), minted };
}

describe('MintController', () => {
  it('mints the requested count, each id carrying the held node and the requested bucket', async () => {
    const { controller, minted } = await setup();

    const { ids } = controller.mint({ bucket: 4095, count: 3 }, 'api');

    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(decode(id)).toMatchObject({ nodeId: 7, bucket: 4095 });
    expect(minted.inc).toHaveBeenCalledWith({ caller: 'api' }, 3);
  });

  it('refuses without a lease and counts nothing', async () => {
    const { controller, minted } = await setup(false);

    expect(() => controller.mint({ bucket: 0, count: 1 }, undefined)).toThrow(LeaseNotHeldError);
    expect(minted.inc).not.toHaveBeenCalled();
  });
});
