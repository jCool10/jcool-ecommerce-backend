// Checkout beyond this many PENDING orders per user is refused (409), so an account cycling fresh
// Idempotency-Keys cannot hold stock indefinitely behind orders nobody pays.
export const MAX_PENDING_ORDERS_PER_USER = 3;

// Enforced at checkout as well as at the cart edge, so a cart line from before this cap cannot
// check out past it.
export const MAX_QUANTITY_PER_ORDER_LINE = 10;
