import { minutes, seconds, type ThrottlerOptions } from '@nestjs/throttler';

/**
 * Rate-limiting tiers. Two named throttlers run together on every request:
 *
 * - `default` — keyed by client IP. The floor for the whole app: sheds DoS and
 *   password-spray (many accounts hammered from one IP).
 * - `account` — keyed by IP + hashed account on auth routes (IP elsewhere). Caps
 *   a brute-force run against a single account without lockout of other users
 *   behind the same NAT. See {@link AccountAwareThrottlerGuard.getTracker}.
 */
export const DEFAULT_THROTTLER = 'default';
export const ACCOUNT_THROTTLER = 'account';

/**
 * Global defaults applied to every route unless a handler overrides them via
 * `@Throttle`. `account` is deliberately non-binding here (its limit sits above
 * the `default` tier's sustained rate, so `default` always trips first on
 * ordinary traffic) — its teeth come from the per-route overrides below.
 */
export const GLOBAL_THROTTLERS: ThrottlerOptions[] = [
  { name: DEFAULT_THROTTLER, ttl: seconds(60), limit: 100 },
  { name: ACCOUNT_THROTTLER, ttl: minutes(15), limit: 5000 },
];

/**
 * Auth-route overrides. Progressive by construction: a tight per-minute window
 * (`default`, per IP) plus a longer window whose `blockDuration` locks the
 * offender out well past the window reset (`account`, per IP + account).
 */
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
