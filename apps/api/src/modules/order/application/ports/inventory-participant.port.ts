export const INVENTORY_TCC = Symbol('INVENTORY_TCC');

/** Order speaks `skuId`; the adapter maps it to the variant stock is held by. */
export interface ReserveLine {
  skuId: string;
  quantity: number;
}

export type ReserveOutcome = 'HELD' | 'OUT_OF_STOCK' | 'CONTENDED' | 'CONFLICT';

/** Idempotent per order; a throw means the outcome is unknown. */
export interface InventoryTccPort {
  tryReserve(input: { orderId: string; lines: ReserveLine[]; holdUntil: Date }): Promise<ReserveOutcome>;
  commit(orderId: string): Promise<'COMMITTED' | 'CONFLICT'>;
  release(orderId: string): Promise<'RELEASED' | 'FENCED' | 'CONFLICT'>;
  restock(orderId: string): Promise<'RESTOCKED' | 'CONFLICT'>;
}
