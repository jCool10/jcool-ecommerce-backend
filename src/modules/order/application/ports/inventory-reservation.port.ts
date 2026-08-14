/**
 * EXTENSION — BF#1 Overselling (Week 4): DECLARED, NOT WIRED in Week 3.
 *
 * The interface exists so `PlaceOrderUseCase` has a named seam to call, but no
 * provider is bound to `INVENTORY_RESERVATION` yet and place-order does not invoke
 * it. Week 4 supplies a real adapter (holds stock inside the placement transaction,
 * using the reserved `orders.version` column for optimistic locking) — additive:
 * inject the adapter and uncomment the reserve call, no controller/state-machine
 * change. Keeping only the contract here avoids over-engineering (YAGNI) while
 * fixing the boundary.
 */
export const INVENTORY_RESERVATION = Symbol('INVENTORY_RESERVATION');

/** One line to reserve stock for. */
export interface ReservationLine {
  skuId: string;
  quantity: number;
}

export interface InventoryReservationPort {
  /** Reserve stock for the given lines; throws/return-shape defined when wired (Week 4). */
  reserve(orderId: string, lines: ReservationLine[]): Promise<void>;
}
