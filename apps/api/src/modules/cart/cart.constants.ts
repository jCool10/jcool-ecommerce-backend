// Per-line quantity ceiling. Enforced at the DTO edge for one request AND inside the accumulating
// upsert for the running total, so a cart line can never hold more than checkout's own per-SKU cap
// would let through (Order's MAX_QUANTITY_PER_ORDER_LINE — kept as its own constant here rather than
// imported, since a context may not reach into another's internals).
export const MAX_LINE_QUANTITY = 10;
