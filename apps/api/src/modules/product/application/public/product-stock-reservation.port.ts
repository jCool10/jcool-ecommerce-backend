/** At most one line per `variantId` — a duplicate variant is held once, not summed. */
export interface ReservationLine {
  variantId: string;
  quantity: number;
}
