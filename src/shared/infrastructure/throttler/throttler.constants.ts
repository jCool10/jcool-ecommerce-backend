import { minutes, seconds, type ThrottlerOptions } from '@nestjs/throttler';

/**
 * Rate-limiting tiers: `default` keyed by IP (app-wide floor — sheds DoS + password-spray),
 * `account` keyed by IP + hashed account on auth routes (caps a single-account brute-force),
 * `user` keyed by the authenticated id on write routes (caps one account however many IPs it
 * spreads across). See docs/engineering-notes.md (Auth — Rate limiting / brute-force protection).
 */
export const DEFAULT_THROTTLER = 'default';
export const ACCOUNT_THROTTLER = 'account';
export const USER_THROTTLER = 'user';

/** Global defaults for every route unless `@Throttle` overrides; `account` and `user` sit above `default` so they never bind ordinary traffic (their teeth are the per-route overrides below). */
export const GLOBAL_THROTTLERS: ThrottlerOptions[] = [
  { name: DEFAULT_THROTTLER, ttl: seconds(60), limit: 100 },
  { name: ACCOUNT_THROTTLER, ttl: minutes(15), limit: 5000 },
  // Configured globally so `@Throttle` can override it, but only UserThrottlerGuard ever enforces
  // it — the global guard runs ahead of authentication, with no user to key by.
  { name: USER_THROTTLER, ttl: minutes(15), limit: 5000 },
];

/** Auth-route overrides: a tight per-minute IP window plus a longer per-(IP,account) window that blocks past the reset. */
export const LOGIN_THROTTLE = {
  [DEFAULT_THROTTLER]: { limit: 20, ttl: seconds(60), blockDuration: minutes(5) },
  [ACCOUNT_THROTTLER]: { limit: 5, ttl: minutes(15), blockDuration: minutes(15) },
};

// Registration shares login's shape: cheap to attempt, worth the same throttle.
export const REGISTER_THROTTLE = LOGIN_THROTTLE;

// Refresh carries no email, so only the IP tier is meaningful here.
export const REFRESH_THROTTLE = {
  [DEFAULT_THROTTLER]: { limit: 30, ttl: seconds(60), blockDuration: minutes(5) },
};

/**
 * Checkout writes: an IP window loose enough for a shared office NAT, plus a per-user window an
 * account can't outrun by rotating IPs. `blockDuration` is left to default to the ttl — unlike a
 * login flood, going over here is usually a client retrying too fast, so the lockout should end
 * with the window rather than outlast it by minutes and cost a real buyer the sale.
 */
export const ORDER_THROTTLE = {
  [DEFAULT_THROTTLER]: { limit: 30, ttl: seconds(60) },
  [USER_THROTTLER]: { limit: 10, ttl: seconds(60) },
};

// Opening a payment session is the same checkout flow one step on, and every attempt costs an
// outbound call to the gateway: same shape.
export const PAYMENT_SESSION_THROTTLE = ORDER_THROTTLE;
