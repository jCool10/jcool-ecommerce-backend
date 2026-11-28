import { describe, expect, it, vi } from 'vitest';
import { CartSnapshotLocalAdapter } from './cart-snapshot.local-adapter';

describe('CartSnapshotLocalAdapter', () => {
  it("reads the buyer's lines in cart order as Order's own shape", async () => {
    const getLines = vi.fn().mockResolvedValue([
      { skuId: '300', quantity: 1, extra: 'dropped' },
      { skuId: '100', quantity: 4 },
    ]);
    const adapter = new CartSnapshotLocalAdapter({ getLines });

    await expect(adapter.getLines('42')).resolves.toEqual([
      { skuId: '300', quantity: 1 },
      { skuId: '100', quantity: 4 },
    ]);
    expect(getLines).toHaveBeenCalledExactlyOnceWith('42');
  });

  it('reads an absent cart as no lines', async () => {
    const adapter = new CartSnapshotLocalAdapter({ getLines: () => Promise.resolve([]) });

    await expect(adapter.getLines('42')).resolves.toEqual([]);
  });
});
