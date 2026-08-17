// Shared config for the register-uniqueness k6 mixes.
//
// Preconditions (same as k6/baseline.js):
//   - stack up: docker compose up -d  (postgres on :5433)
//   - app running with THROTTLE_ENABLED=false  (single-host load otherwise trips
//     the per-IP register limiter and the run measures the throttle, not the DB)
//   - table pre-seeded for the duplicate mix: npm run seed:users:bulk
//
// Authoritative latency comes from the app's own Prometheus histogram
// (route:http_request_duration_seconds:p99), not k6 client timing — k6 only drives load.

export const BASE = __ENV.BASE_URL || 'http://localhost:3000';
export const JSON_HDR = { 'Content-Type': 'application/json' };

// Passes the register DTO (email + password, min length 8).
export const PW = __ENV.PW || 'correct horse battery staple';

// Must match the seeder (scripts/seed-users-bulk.ts): the duplicate mix and the
// write mix's duplicate fraction target these pre-seeded rows to force 409s.
export const SEED_PREFIX = __ENV.SEED_PREFIX || 'loadtest+';
export const SEED_DOMAIN = __ENV.SEED_DOMAIN || 'loadtest.jcool.local';
export const SEED_COUNT = Number(__ENV.SEED_COUNT || 200000);

export function seededEmail(i) {
  return `${SEED_PREFIX}${i}@${SEED_DOMAIN}`;
}

// A random already-seeded email (expected to collide → 409).
export function existingEmail() {
  return seededEmail(Math.floor(Math.random() * SEED_COUNT));
}

// A never-before-seen email (expected → 201). Unique across VUs/iterations/runs;
// same prefix so `npm run seed:users:bulk -- --clean` removes it afterwards.
export function freshEmail(runId) {
  return `${SEED_PREFIX}w-${__VU}-${__ITER}-${runId}@${SEED_DOMAIN}`;
}
