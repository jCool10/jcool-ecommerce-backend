// Experiment B — cache stampede: what single-flight and SWR each buy.
//
// Drives a FLAT read load at a narrow catalog key space while the catalog generation counter is
// bumped out-of-band, so every key goes cold at the same instant and a herd forms. Run three times
// with only the app's cache .env changed; the number being compared is catalog source reads/s:
//
//   sum(rate(catalog_cache_operations_total{result=~"rebuild|lock_timeout|error_fallthrough"}[5m]))
//
// That is a DIRECT count of lookups that reached Postgres, not a proxy — k6 client timing is not
// authoritative here and is not thresholded.
//
// Arms (app .env — k6 is identical in all three; ARM only labels the artifact directory):
//   protected    CACHE_STALE_WINDOW_SEC=30 CACHE_TTL_JITTER_SEC=10 CACHE_LOCK_WAIT_MS=500
//   no-swr       CACHE_STALE_WINDOW_SEC=0  CACHE_TTL_JITTER_SEC=0  CACHE_LOCK_WAIT_MS=500
//   unprotected  CACHE_STALE_WINDOW_SEC=0  CACHE_TTL_JITTER_SEC=0  CACHE_LOCK_WAIT_MS=0
// Set CACHE_SOFT_TTL_SEC=30 in ALL arms so natural expiry and the bump cadence agree.
// `docker compose restart app` + ~1 min re-warm between arms.
//
// Preconditions: see test/load/shared/config.js. Additionally, the stampede trigger must be
// running in a second terminal for the whole measured window — it is the product's own O(1)
// invalidation, not a synthetic TTL race:
//
//   while true; do redis-cli -p 6380 INCR catalog:v2:ver; sleep 30; done
//
// Verify it lands before trusting an arm (`redis-cli -p 6380 GET catalog:v2:ver` must climb): the
// app talks to redis:6379 inside the compose network, the host uses 6380 — same server, different
// address. If they ever diverge the trigger silently does nothing and all three arms look alike.
//
// Run:  ARM=protected npm run load:cache-stampede
// Tunables (env): BASE_URL, ARM, RATE, DURATION, SLUG_COUNT, DETAIL_SHARE, PRE_ALLOCATED_VUS,
//                 MAX_VUS, MIN_OK_RATIO, PAGE_SIZE, OUT_DIR

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE, toSeconds } from '../shared/config.js';
import {
  ARM,
  DETAIL_SHARE,
  DURATION,
  MAX_VUS,
  MIN_OK_RATIO,
  PRE_ALLOCATED_VUS,
  RATE,
  SLUG_COUNT,
  narrowKeySpace,
} from './config.js';

// Both routes counted separately and thresholded against the load shape. A run where the slug set
// went stale answers 404 on every detail — http_req_failed stays low (404 is not a k6 failure),
// checks still mostly pass, and the arm would publish a source-read number produced by a workload
// that never touched the detail cache strand. These counters are what make that fail loudly.
const listOk = new Counter('cat_list_200');
const detailOk = new Counter('cat_detail_200');
// MUST stay 0. status 0 = connection reset / timeout, which at this rate means the app fell over.
const cat5xx = new Counter('cat_5xx');

const durationSec = toSeconds(DURATION);
const plannedDetail = RATE * durationSec * DETAIL_SHARE;
const plannedList = RATE * durationSec * (1 - DETAIL_SHARE);

export const options = {
  // Bodies are read for the 200 check only; dropping them keeps the generator cheap so k6 does not
  // become the bottleneck it is supposed to be measuring around.
  discardResponseBodies: true,
  scenarios: {
    stampede: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    // Anti-false-green: both routes must have actually been served, at close to the offered rate.
    cat_list_200: [`count>${Math.floor(plannedList * MIN_OK_RATIO)}`],
    cat_detail_200: [`count>${Math.floor(plannedDetail * MIN_OK_RATIO)}`],
    cat_5xx: ['count==0'],
    // A dropped iteration means the OFFERED load differed between arms, which voids the whole
    // comparison — the arms are only comparable at identical offered load.
    dropped_iterations: ['count==0'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // http_req_duration deliberately NOT thresholded: authoritative latency is
    // route:http_request_duration_seconds:p99 from Prometheus. It still prints for info.
  },
};

export function setup() {
  const slugs = narrowKeySpace();
  if (slugs.length < SLUG_COUNT) {
    throw new Error(`need ${SLUG_COUNT} slugs for a herd, catalog page 1 gave ${slugs.length}`);
  }
  console.log(`arm=${ARM} rate=${RATE}/s duration=${DURATION} keys=[${slugs.join(', ')}]`);
  return { slugs };
}

export default function (data) {
  if (Math.random() < DETAIL_SHARE) {
    // Detail strand: one cache key per slug, the tightest herd in the experiment.
    const res = http.get(`${BASE}/products/${data.slugs[__ITER % data.slugs.length]}`, {
      tags: { name: 'GET /products/:slug' },
    });
    if (res.status === 200) detailOk.add(1);
    else if (res.status >= 500 || res.status === 0) cat5xx.add(1);
    check(res, { 'detail 200': (r) => r.status === 200 });
    return;
  }
  // List strand: page 1 only, so every request shares ONE cache key fingerprint. A wider page
  // range here would spread the load across keys and there would be no herd to measure.
  const res = http.get(`${BASE}/products?page=1&pageSize=20`, { tags: { name: 'GET /products' } });
  if (res.status === 200) listOk.add(1);
  else if (res.status >= 500 || res.status === 0) cat5xx.add(1);
  check(res, { 'list 200': (r) => r.status === 200 });
}
