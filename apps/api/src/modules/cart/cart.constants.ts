// Per-line quantity ceiling. Enforced at the DTO edge for one request AND inside the accumulating
// upsert for the running total, so a cart line can never hold more than checkout's own per-SKU cap
// would let through (Order's MAX_QUANTITY_PER_ORDER_LINE — kept as its own constant here rather than
// imported, since a context may not reach into another's internals).
export const MAX_LINE_QUANTITY = 10;

// Distinct SKUs per cart: a view prices every line in one read and a checkout walks them all, so an
// unbounded cart is an unbounded request for anyone holding an account. Must not exceed the
// inventory-service's per-Try line limit (100), or a full cart could never check out.
export const MAX_CART_LINES = 100;
