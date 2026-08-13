import { minutes, seconds, type ThrottlerOptions } from '@nestjs/throttler';

/**
 * Rate-limiting tiers: `default` keyed by IP (app-wide floor — sheds DoS + password-spray),
 * `account` keyed by IP + hashed account on auth routes (caps a single-account brute-force).
 * See docs/engineering-notes.md (Auth — Rate limiting / brute-force protection).
 */
export const DEFAULT_THROTTLER = 'default';
export const ACCOUNT_THROTTLER = 'account';

/** Global defaults for every route unless `@Throttle` overrides; `account` sits above `default` so it never binds ordinary traffic (its teeth are the per-route overrides below). */
export const GLOBAL_THROTTLERS: ThrottlerOptions[] = [
  { name: DEFAULT_THROTTLER, ttl: seconds(60), limit: 100 },
  { name: ACCOUNT_THROTTLER, ttl: minutes(15), limit: 5000 },
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
