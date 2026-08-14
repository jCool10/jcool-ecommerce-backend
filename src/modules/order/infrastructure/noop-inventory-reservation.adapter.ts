import { Injectable } from '@nestjs/common';
import type { InventoryReservationPort, ReservationLine } from '../application/ports/inventory-reservation.port';

/**
 * Week-3 no-op reservation — the "bơm no-op" the plan calls for. Placing an order
 * calls `reserve(...)`, but nothing is held yet: real stock reservation is BF#1
 * (Week 4), which swaps this class for an adapter that holds stock inside the
 * placement transaction (using `orders.version` for optimistic locking). Keeping
 * the call wired now means Week 4 is a provider swap, not a control-flow change.
 */
@Injectable()
export class NoopInventoryReservation implements InventoryReservationPort {
  reserve(_orderId: string, _lines: ReservationLine[]): Promise<void> {
    // Intentionally does nothing in Week 3 (no stock model yet).
    return Promise.resolve();
  }
}
