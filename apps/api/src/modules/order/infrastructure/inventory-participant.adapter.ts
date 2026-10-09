import { Inject, Injectable } from '@nestjs/common';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '@modules/product/application/public/inventory-participant.port';
import type { InventoryTccPort, ReserveLine, ReserveOutcome } from '../application/ports/inventory-participant.port';

@Injectable()
export class InventoryParticipantAdapter implements InventoryTccPort {
  constructor(@Inject(INVENTORY_PARTICIPANT) private readonly inventory: InventoryParticipant) {}

  async tryReserve(input: { orderId: string; lines: ReserveLine[]; holdUntil: Date }): Promise<ReserveOutcome> {
    const { outcome } = await this.inventory.tryReserve({
      orderId: input.orderId,
      lines: input.lines.map((line) => ({ variantId: line.skuId, quantity: line.quantity })),
      holdUntil: input.holdUntil,
    });
    return outcome;
  }

  async commit(orderId: string): Promise<'COMMITTED' | 'CONFLICT'> {
    return (await this.inventory.commit(orderId)).outcome;
  }

  async release(orderId: string): Promise<'RELEASED' | 'FENCED' | 'CONFLICT'> {
    return (await this.inventory.release(orderId)).outcome;
  }

  async restock(orderId: string): Promise<'RESTOCKED' | 'CONFLICT'> {
    return (await this.inventory.restock(orderId)).outcome;
  }
}
