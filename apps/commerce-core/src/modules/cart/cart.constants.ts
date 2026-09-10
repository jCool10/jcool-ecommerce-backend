// Per-line quantity ceiling, kept well inside int4 so repeated accumulating adds cannot overflow
// `cart_items.quantity` (a plain `integer` with no CHECK) into a Postgres error surfacing as a 500.
// Enforced at the DTO edge for one request AND inside the accumulating upsert for the running total.
export const MAX_LINE_QUANTITY = 10_000;
