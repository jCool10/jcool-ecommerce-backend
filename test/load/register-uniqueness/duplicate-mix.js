// Duplicate / insert-probe mix — every request re-registers an ALREADY-seeded
// email, so all should return 409. After the Phase 1 pure insert-on-conflict there
// is NO existence SELECT to measure; what actually costs DB work on a duplicate is
// the unique-index probe every `INSERT ... ON CONFLICT` performs and the redundant
// INSERT attempt. This mix isolates that cost — the real signal the B-bloom gate
// keys on (a bloom fast-path would let the app skip these redundant INSERTs).
//
//   npm run load:register:dup
//   env: BASE_URL, SEED_COUNT (must match the seed), DUP_VUS, DURATION
//
// Run the app with THROTTLE_ENABLED=false (see config.js). Pair with
// `npm run db:metrics:users` before/after to read index cache-hit under this load.

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { BASE, JSON_HDR, PW, existingEmail } from './config.js';

const dup409 = new Counter('dup_409');
const dup5xx = new Counter('dup_5xx'); // MUST stay 0 — 5xx OR transport failure (status 0)
const dupUnexpected = new Rate('dup_unexpected'); // not 409 (throttle/400/201-should-not-happen)

const DUP_VUS = Number(__ENV.DUP_VUS || 20);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    duplicates: { executor: 'constant-vus', vus: DUP_VUS, duration: DURATION },
  },
  thresholds: {
    dup_5xx: ['count==0'],
    dup_unexpected: ['rate<0.01'],
    // http_req_duration intentionally NOT thresholded — authoritative latency is the app's
    // Prometheus histogram (config.js), not k6 client timing. Still printed for info.
  },
};

export default function () {
  const res = http.post(`${BASE}/auth/register`, JSON.stringify({ email: existingEmail(), password: PW }), {
    headers: JSON_HDR,
    tags: { name: 'POST /auth/register (dup)' },
  });

  if (res.status === 409) dup409.add(1);
  else if (res.status >= 500 || res.status === 0) dup5xx.add(1); // status 0 = connection reset/crash
  dupUnexpected.add(res.status !== 409);

  check(res, { 'duplicate returns 409 (never 5xx)': (r) => r.status === 409 });
}
