import type { InventoryParticipant } from '@modules/product/application/public/inventory-participant.port';
import type { OrderInventoryParticipantPort } from '../application/ports/order-inventory-participant.port';
import { OrderInventoryParticipantAdapter } from './order-inventory-participant.adapter';

describe('OrderInventoryParticipantAdapter', () => {
  const build = () => {
    const participant = {
      tryReserve: vi.fn<InventoryParticipant['tryReserve']>(),
      commit: vi.fn<InventoryParticipant['commit']>(),
      release: vi.fn<InventoryParticipant['release']>(),
      restock: vi.fn<InventoryParticipant['restock']>(),
      statusOf: vi.fn<InventoryParticipant['statusOf']>(),
    };
    const adapter: OrderInventoryParticipantPort = new OrderInventoryParticipantAdapter(participant);
    return { adapter, participant };
  };

  it('speaks variant ids to stock and hands its Try outcome back untouched', async () => {
    const { adapter, participant } = build();
    participant.tryReserve.mockResolvedValue('CONTENDED');
    const holdUntil = new Date('2026-10-21T10:00:00.000Z');

    const outcome = await adapter.tryReserve(
      { orderId: 'o-1', lines: [{ skuId: 'sku-1', quantity: 2 }], holdUntil },
      { signal: new AbortController().signal },
    );

    expect(outcome).toBe('CONTENDED');
    expect(participant.tryReserve).toHaveBeenCalledWith({
      orderId: 'o-1',
      lines: [{ variantId: 'sku-1', quantity: 2 }],
      holdUntil,
    });
  });

  it.each(['commit', 'release', 'restock'] as const)('forwards %s by order id', async (method) => {
    const { adapter, participant } = build();
    participant[method].mockResolvedValue('IDEMPOTENT');

    await expect(adapter[method]('o-1')).resolves.toBe('IDEMPOTENT');
    expect(participant[method]).toHaveBeenCalledWith('o-1');
  });

  it('forwards statusOf for the whole batch', async () => {
    const { adapter, participant } = build();
    const statuses = new Map([
      ['o-1', 'HELD' as const],
      ['o-2', null],
    ]);
    participant.statusOf.mockResolvedValue(statuses);

    await expect(adapter.statusOf(['o-1', 'o-2'])).resolves.toEqual(statuses);
    expect(participant.statusOf).toHaveBeenCalledWith(['o-1', 'o-2']);
  });

  it('lets a transient fault through for the caller to retry', async () => {
    const { adapter, participant } = build();
    const fault = new Error('lock timeout');
    participant.commit.mockRejectedValue(fault);

    await expect(adapter.commit('o-1')).rejects.toBe(fault);
  });
});
