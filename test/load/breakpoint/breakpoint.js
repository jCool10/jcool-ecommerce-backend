// Experiment A — breakpoint / knee: capacity number + bottleneck layer.
//
// Ramps OFFERED load in held steps until the latency SLO breaks, so the two numbers an interviewer
// will probe can be read off the app's own recording rules:
//   R_sustain = highest held step where job:http_request_latency_violation:ratio5m < 0.01
//               AND job:http_request_error_rate:ratio5m < 0.001
//   R_knee    = first step where p99 > 2× its value at R_sustain, or served throughput rises
//               < 20% while offered rate doubles
//
// WHY NOT k6/baseline.js: that script uses `ramping-vus` — a CLOSED model. Each VU issues its
// next request only after the previous one returns, so as latency rises the offered rate FALLS
// and the generator self-throttles away from the knee. It converges on whatever the system can
// serve and reports it as if it were the demand. This script uses `ramping-arrival-rate` (open
// model): requests are issued on a schedule regardless of response time, and k6's
// `dropped_iterations` becomes the signal that the GENERATOR, not the SUT, ran out of capacity —
// which is why it is thresholded to 0 rather than ignored.
//
// Two profiles, run separately:
//   PROFILE=read   70% GET /products (spread over pages) + 30% GET /products/:slug, wide key space
//   PROFILE=mixed  20% write journey (register→login cached per VU → cart add → place order),
//                  80% read. Tokens are minted ONCE per VU: per-iteration auth would make this a
//                  measurement of argon2 and nothing else.
//
// Preconditions: see test/load/shared/config.js. Additionally the rig must be pinned
// (docker-compose cpus/mem_limit — Phase 1) or the number is not reproducible, and k6 must have
// CPU headroom left over: at the top step the generator needs real cores.
//
// Run:  PROFILE=read npm run load:breakpoint
//       PROFILE=mixed npm run load:breakpoint
//       STEP=2m npm run load:breakpoint        # calibration pass — publish nothing from it
// Tunables (env): BASE_URL, PROFILE, LEVELS, STEP, RAMP, PRE_ALLOCATED_VUS, MAX_VUS,
//                 WRITE_SHARE, DETAIL_SHARE, CATALOG_PAGES, MIN_OK_RATIO, OUT_DIR
//
// Mandatory cross-check after every run: k6's iteration count must agree with Prometheus'
// sum(increase(http_requests_total[<window>])) within ~2%. A persistent gap is the RED blind spot —
// guard-layer rejections (429 from a throttler that was supposed to be off) never reach the
// interceptor that records the histogram, so the run looks green and fast while measuring the
// rate limiter.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { LOAD_EMAIL_DOMAIN, plannedRampIterations } from '../shared/config.js';
import {
  BASE,
  DETAIL_SHARE,
  JSON_HDR,
  LEVELS,
  MAX_VUS,
  MIN_OK_RATIO,
  PRE_ALLOCATED_VUS,
  PROFILE,
  WRITE_SHARE,
  authHeaders,
  mintToken,
  pick,
  rampStages,
  stepBoundaries,
  uuidv4,
  wideKeySpace,
} from './config.js';

const readOk = new Counter('bp_read_200');
// Write-path counters. Without them a run where login stopped returning a token degrades into a
// pure read run: http_req_failed stays low, checks still pass, and the "mixed" capacity number
// would actually be the read number under a different name.
const writeOps = new Counter('bp_write_ops');
const placeOk = new Counter('bp_place_201');

const stages = rampStages();
const planned = plannedRampIterations(LEVELS[0], stages);
const plannedRead = planned * (1 - WRITE_SHARE);
const plannedWrite = planned * WRITE_SHARE;

const thresholds = {
  // Looser than baseline: this run INTENDS to break the system. The knee is read from Prometheus,
  // not from this threshold — it exists only to fail a run that was broken from the first step.
  http_req_failed: ['rate<0.05'],
  // The whole experiment rests on OFFERED load being what the shape says. A starved generator
  // produces a low, confident, wrong capacity number, so it fails the run instead.
  dropped_iterations: ['count==0'],
  bp_read_200: [`count>${Math.floor(plannedRead * MIN_OK_RATIO)}`],
  // http_req_duration deliberately NOT thresholded: authoritative latency is
  // route:http_request_duration_seconds:p99 from Prometheus.
};

if (PROFILE === 'mixed') {
  thresholds.bp_write_ops = [`count>${Math.floor(plannedWrite * MIN_OK_RATIO)}`];
  // Placement reserves stock; an all-409 checkout path (stock not seeded, or depleted) drops this
  // to zero. Kept as a low absolute floor rather than a share of the shape, because shedding at
  // the top steps is the expected outcome here, not a defect.
  thresholds.bp_place_201 = ['count>20'];
}

export const options = {
  discardResponseBodies: true,
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: LEVELS[0],
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages,
    },
  },
  thresholds,
};

export function setup() {
  const { slugs, skus } = wideKeySpace();
  if (PROFILE === 'mixed' && !skus.length) throw new Error('mixed profile needs SKUs: reseed the catalog');
  console.log(
    `profile=${PROFILE} levels=[${LEVELS.join(', ')}] slugs=${slugs.length} skus=${skus.length}\n` +
      `step boundaries (query each level from the LAST 60s of its hold):\n${stepBoundaries()}`,
  );
  return { slugs, skus, runId: Date.now() };
}

// Per-VU token cache — each k6 VU is its own JS runtime, so module scope is per-VU.
let token = null;

export default function (data) {
  if (Math.random() < WRITE_SHARE) {
    write(data);
    return;
  }
  read(data);
}

function read(data) {
  if (Math.random() < DETAIL_SHARE) {
    const res = http.get(`${BASE}/products/${pick(data.slugs)}`, { tags: { name: 'GET /products/:slug' } });
    if (res.status === 200) readOk.add(1);
    check(res, { 'detail 200': (r) => r.status === 200 });
    return;
  }
  // Random page across the discovered range: wide key space, so no single cache entry carries the
  // load and what is measured is steady-state capacity rather than Experiment B's herd.
  const page = 1 + Math.floor(Math.random() * Math.ceil(data.slugs.length / 20));
  const res = http.get(`${BASE}/products?page=${page}&pageSize=20`, { tags: { name: 'GET /products' } });
  if (res.status === 200) readOk.add(1);
  check(res, { 'list 200': (r) => r.status === 200 });
}

function write(data) {
  if (!token) {
    token = mintToken(`bp-vu${__VU}-${data.runId}@${LOAD_EMAIL_DOMAIN}`);
    check(null, { 'login token': () => !!token });
  }
  if (!token) return; // counted by the check above; bp_write_ops staying flat fails the run
  const auth = authHeaders(token);

  const sku = pick(data.skus);
  http.post(`${BASE}/cart/items`, JSON.stringify({ skuId: sku, quantity: 1 }), {
    ...auth,
    tags: { name: 'POST /cart/items' },
  });
  writeOps.add(1);

  const order = http.post(`${BASE}/orders`, null, {
    headers: { ...auth.headers, ...JSON_HDR, 'Idempotency-Key': uuidv4() },
    tags: { name: 'POST /orders' },
  });
  if (check(order, { 'order placed 201': (r) => r.status === 201 })) placeOk.add(1);
}
