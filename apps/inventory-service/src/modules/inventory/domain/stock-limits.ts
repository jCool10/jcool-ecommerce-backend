export const INT4_MAX = 2_147_483_647;

/**
 * Ceiling for an operator-set or adjusted on-hand. Half of int4 is the headroom for a delta (itself
 * bounded by this) and for restocks to add back without the column overflowing.
 */
export const MAX_STOCK_ON_HAND = 1_000_000_000;

/** A Try holds row locks for its whole budget, one statement per line; more lines than this cannot fit it. */
export const MAX_RESERVATION_LINES = 100;
