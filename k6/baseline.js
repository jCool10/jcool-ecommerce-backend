// k6 baseline load test — produces the p50/p95/p99 numbers used to tune the
// http_request_duration_seconds histogram buckets and the SLO targets.
//
// Deliberately SUCCESS-PATH only (no 404/401/5xx noise): buckets are tuned to the latency of
// healthy traffic, so an error burst would skew the tail. For the varied demo (errors + burn-rate
// alert) use the separate traffic-sim script, not this one.
//
//   read  : GET /products + GET /products/:slug, ramped 5 → 10 → 20 VUs
//   write : register → login → cart add/patch → place order → list, 3 constant VUs
//
// The authoritative latency numbers come from the APP's own Prometheus histogram
// (route:http_request_duration_seconds:p99), not k6's client-side timing — k6 only drives load.
//
// Run:  k6 run k6/baseline.js         (or: npm run load:baseline)
// Tunables (env):  BASE_URL, READ_PEAK_VUS, WRITE_VUS
//
// Preconditions: stack up (docker compose --profile observability up -d), DB seeded
// (npm run db:seed — also seeds generous inventory stock so placement, which now reserves
// stock, stays on the success path), THROTTLE_ENABLED=false (single-host load would otherwise
// hit the 100 req/60s limiter), and auth.requireVerifiedEmail=false (the default) so login
// returns a token with no email step.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

// Counts cart/order writes that actually executed — thresholded below so a login failure that
// silently degrades this into a read-only run fails the run loudly instead of passing green.
const writeOps = new Counter('sim_write_ops');

// Counts order placements that returned 201. Placement reserves stock, so an all-409 checkout
// path (stock not seeded, or depleted) drops this to zero and fails the run loudly instead of
// only surfacing as http_req_failed noise.
const placeOps = new Counter('sim_place_ops');

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const PW = 'correct horse battery staple';
const READ_PEAK_VUS = Number(__ENV.READ_PEAK_VUS || 20);
const WRITE_VUS = Number(__ENV.WRITE_VUS || 3);
const JSON_HDR = { 'Content-Type': 'application/json' };

export const options = {
  discardResponseBodies: false,
  scenarios: {
    read: {
      executor: 'ramping-vus',
      exec: 'read',
      startVUs: 2,
      stages: [
        { duration: '30s', target: Math.round(READ_PEAK_VUS * 0.25) }, // 5
        { duration: '60s', target: Math.round(READ_PEAK_VUS * 0.5) }, //  10
        { duration: '90s', target: READ_PEAK_VUS }, //                    20 (peak — tail lives here)
        { duration: '20s', target: 2 },
      ],
    },
    write: {
      executor: 'constant-vus',
      exec: 'write',
      vus: WRITE_VUS,
      duration: '3m20s',
      startTime: '10s',
    },
  },
  // Client-side sanity thresholds (not the SLO — that lives in Prometheus). Fail the run loudly
  // if the baseline is not actually healthy, so we never tune buckets off a broken run.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.95'],
    // Fail loudly if the write path never ran (e.g. login returned no token): otherwise a
    // read-only run still passes the checks above and the order-value tuning rests on no data.
    sim_write_ops: ['count>50'],
    // Fail loudly if placement never succeeded (e.g. stock not seeded → every place 409s):
    // the order-value / place-latency tuning would otherwise rest on no successful placements.
    sim_place_ops: ['count>20'],
  },
};

function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}

// POST /orders is guarded by a required Idempotency-Key (any UUID). A fresh one per attempt keeps
// each VU's placements distinct — a repeated key would replay the first order instead of creating one.
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// setup() runs once — discover live slugs + variant ids so cart/order hit real SKUs.
export function setup() {
  const res = http.get(`${BASE}/products`);
  const body = res.json();
  const slugs = [];
  const skus = [];
  for (const p of body.items || []) {
    slugs.push(p.slug);
    const detail = http.get(`${BASE}/products/${p.slug}`).json();
    for (const v of detail.variants || []) skus.push(v.id);
  }
  console.log(`setup: ${slugs.length} products, ${skus.length} SKUs discovered`);
  if (!slugs.length || !skus.length) throw new Error('seed missing: run npm run db:seed');
  return { slugs, skus, runId: Date.now() };
}

export function read(data) {
  const list = http.get(`${BASE}/products`, { tags: { name: 'GET /products' } });
  check(list, { 'products 200': (r) => r.status === 200 });
  sleep(0.2 + Math.random() * 0.4);
  const detail = http.get(`${BASE}/products/${pick(data.slugs)}`, {
    tags: { name: 'GET /products/:slug' },
  });
  check(detail, { 'detail 200': (r) => r.status === 200 });
  sleep(0.3 + Math.random() * 0.9);
}

// Per-VU token cache (each k6 VU is its own JS runtime → module scope is per-VU).
let token = null;
export function write(data) {
  if (!token) {
    const email = `bl_vu${__VU}_${data.runId}@example.com`;
    http.post(`${BASE}/auth/register`, JSON.stringify({ email, password: PW }), {
      headers: JSON_HDR,
      tags: { name: 'POST /auth/register' },
    });
    const lr = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PW }), {
      headers: JSON_HDR,
      tags: { name: 'POST /auth/login' },
    });
    token = lr.json('accessToken');
    check(lr, { 'login token': () => !!token });
  }
  if (!token) {
    sleep(1);
    return;
  }
  const auth = { headers: { ...JSON_HDR, Authorization: `Bearer ${token}` } };

  http.get(`${BASE}/cart`, { ...auth, tags: { name: 'GET /cart' } });
  const sku = pick(data.skus);
  http.post(
    `${BASE}/cart/items`,
    JSON.stringify({ skuId: sku, quantity: 1 + Math.floor(Math.random() * 3) }),
    { ...auth, tags: { name: 'POST /cart/items' } },
  );
  writeOps.add(1);
  if (Math.random() < 0.5) {
    http.patch(`${BASE}/cart/items/${sku}`, JSON.stringify({ quantity: 2 }), {
      ...auth,
      tags: { name: 'PATCH /cart/items/:skuId' },
    });
  }
  if (Math.random() < 0.5) {
    const oc = http.post(`${BASE}/orders`, null, {
      headers: { ...auth.headers, 'Idempotency-Key': uuidv4() },
      tags: { name: 'POST /orders' },
    });
    // Checkout snapshots the cart and reserves stock in one transaction, so a 201 IS the placement.
    // A 409 means stock wasn't seeded (or was depleted) — the check + counter surface that as a run
    // failure instead of it hiding in http_req_failed.
    if (check(oc, { 'order placed 201': (r) => r.status === 201 })) {
      placeOps.add(1);
    }
    http.get(`${BASE}/orders`, { ...auth, tags: { name: 'GET /orders' } });
  }
  sleep(0.5 + Math.random() * 1.0);
}
