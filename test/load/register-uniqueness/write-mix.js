// Write mix — concurrent POST /auth/register, mostly-new emails with a controlled
// duplicate fraction (DUP_RATE), to measure insert-on-conflict throughput and the
// 201/409 split under contention. The invariant the correctness fix must uphold:
// a duplicate submission NEVER surfaces as 5xx (it is a clean 409). reg_5xx is
// thresholded to 0 so any 500 fails the run loudly.
//
//   npm run load:register:write
//   env: BASE_URL, DUP_RATE (0..1, default 0.2), SEED_COUNT, WRITE_VUS, DURATION
//
// Run the app with THROTTLE_ENABLED=false (see config.js).

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { BASE, JSON_HDR, PW, existingEmail, freshEmail } from './config.js';

const reg201 = new Counter('reg_201'); // new signups accepted
const reg409 = new Counter('reg_409'); // duplicates cleanly rejected
const reg5xx = new Counter('reg_5xx'); // MUST stay 0 — a 5xx OR transport failure (status 0) means the race regressed
const regUnexpected = new Rate('reg_unexpected'); // anything not 201/409 (e.g. 429 throttle, 400)

const DUP_RATE = Number(__ENV.DUP_RATE || 0.2);
const WRITE_VUS = Number(__ENV.WRITE_VUS || 15);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    write: { executor: 'constant-vus', vus: WRITE_VUS, duration: DURATION },
  },
  thresholds: {
    reg_5xx: ['count==0'],
    reg_unexpected: ['rate<0.01'],
    // http_req_duration is intentionally NOT thresholded: authoritative latency is the app's
    // Prometheus histogram (see config.js), not k6 client timing. It still prints for info.
  },
};

export function setup() {
  return { runId: `${Date.now()}` };
}

export default function (data) {
  const duplicate = Math.random() < DUP_RATE;
  const email = duplicate ? existingEmail() : freshEmail(data.runId);
  const res = http.post(`${BASE}/auth/register`, JSON.stringify({ email, password: PW }), {
    headers: JSON_HDR,
    tags: { name: 'POST /auth/register' },
  });

  if (res.status === 201) reg201.add(1);
  else if (res.status === 409) reg409.add(1);
  else if (res.status >= 500 || res.status === 0) reg5xx.add(1); // status 0 = connection reset/crash
  regUnexpected.add(res.status !== 201 && res.status !== 409);

  check(res, { 'status is 201 or 409 (never 5xx)': (r) => r.status === 201 || r.status === 409 });
}
