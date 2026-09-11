// Public-endpoint read profile — measures a DEPLOYED instance over the public internet.
//
// Run:
//   BASE_URL=https://<host> PROFILE=steady npm run load:public-read
//   BASE_URL=https://<host> PROFILE=burst  npm run load:public-read
//
// Only anonymous GET routes are driven. The write journey is intentionally absent: /auth/* is
// capped at 20/60s per IP with a five-minute block once tripped, so a write mix against a public
// deployment measures the lockout, and the accounts it mints would be real rows in a real database.
//
// Three per-route trends are recorded rather than one blended http_req_duration, because the
// question the run has to answer is what the APP costs — and that is only visible as the gap
// between a route that touches Postgres/Redis and one that touches neither.

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE } from '../shared/config.js';
import {
  DURATION,
  MAX_VUS,
  PRE_ALLOCATED_VUS,
  PROFILE,
  RATE,
  ROUTES,
  TIME_UNIT,
} from './config.js';

const listMs = new Trend('route_list_ms', true);
const detailMs = new Trend('route_detail_ms', true);
const healthMs = new Trend('route_health_ms', true);

// http_req_connecting + http_req_tls_handshaking only populate on a NEW connection; k6 keeps
// connections alive, so these are sampled from the handful of real handshakes a run performs.
// One TCP connect is one round trip, which is the cleanest available estimate of the WAN floor.
const throttled = new Counter('http_429');
const served = new Counter('http_200');
const failed5xx = new Counter('http_5xx');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    [PROFILE]: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    // A 429 is a correct answer, not a transport failure, so http_req_failed would not catch a
    // steady run that quietly spent itself against the limiter. This does.
    ...(PROFILE === 'steady' ? { http_429: ['count==0'] } : {}),
    http_5xx: ['count==0'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  const res = http.get(`${BASE}/products?page=1&pageSize=20`, { responseType: 'text' });
  if (res.status !== 200) throw new Error(`GET /products → ${res.status}`);
  const slugs = (res.json().items || []).map((p) => p.slug).sort();
  if (!slugs.length) throw new Error('catalog empty');
  console.log(`profile=${PROFILE} rate=${RATE}/${TIME_UNIT} duration=${DURATION} base=${BASE}`);
  console.log(`slugs=[${slugs.join(', ')}]`);
  return { slugs };
}

function record(res, trend) {
  if (res.status === 200) {
    served.add(1);
    trend.add(res.timings.duration);
  } else if (res.status === 429) throttled.add(1);
  else if (res.status >= 500 || res.status === 0) failed5xx.add(1);
  check(res, { '200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export default function (data) {
  switch (ROUTES[__ITER % ROUTES.length]) {
    case 'detail':
      record(
        http.get(`${BASE}/products/${data.slugs[__ITER % data.slugs.length]}`, {
          tags: { name: 'GET /products/:slug' },
        }),
        detailMs,
      );
      return;
    case 'health':
      // Liveness: no database, no cache, no auth. The floor the other two are read against.
      record(http.get(`${BASE}/health/live`, { tags: { name: 'GET /health/live' } }), healthMs);
      return;
    default:
      record(
        http.get(`${BASE}/products?page=1&pageSize=20`, { tags: { name: 'GET /products' } }),
        listMs,
      );
  }
}
