import { Inject, Injectable } from '@nestjs/common';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
} from '@modules/product/application/public/inventory-participant.port';
import type { ParticipantTryOutcome } from '../domain/checkout-saga';
import type {
  OrderInventoryParticipantPort,
  StockCommandOutcome,
  StockHoldStatus,
  StockTryInput,
} from '../application/ports/order-inventory-participant.port';

// In-process until stock leaves as its own service. The abort signal is not forwarded: the Try is
// already bounded by its own lock budget, and the other commands are single short transactions.
@Injectable()
export class OrderInventoryParticipantAdapter implements OrderInventoryParticipantPort {
  constructor(@Inject(INVENTORY_PARTICIPANT) private readonly participant: InventoryParticipant) {}

  tryReserve({ orderId, lines, holdUntil }: StockTryInput): Promise<ParticipantTryOutcome> {
    return this.participant.tryReserve({
      orderId,
      lines: lines.map((line) => ({ variantId: line.skuId, quantity: line.quantity })),
      holdUntil,
    });
  }

  commit(orderId: string): Promise<StockCommandOutcome> {
    return this.participant.commit(orderId);
  }

  release(orderId: string): Promise<StockCommandOutcome> {
    return this.participant.release(orderId);
  }

  restock(orderId: string): Promise<StockCommandOutcome> {
    return this.participant.restock(orderId);
  }

  statusOf(orderIds: string[]): Promise<Map<string, StockHoldStatus | null>> {
    return this.participant.statusOf(orderIds);
  }
}
