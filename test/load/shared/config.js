// Shared helpers for the performance-program k6 experiments
// (plans/260911-0904-k6-performance-program/ — experiments A, B, C).
//
// Preconditions common to every experiment here (same as k6/baseline.js):
//   - stack up:  docker compose --profile observability up -d
//   - catalog seeded at perf scale:  npm run db:seed:perf  (scripts/perf-seed.ts)
//   - THROTTLE_ENABLED=false — every measured route is throttled otherwise:
//     /auth/* at 20 req/60s per IP with a FIVE-MINUTE block once tripped, and POST /orders
//     at 10 req/60s PER USER (src/shared/infrastructure/throttler/throttler.constants.ts:24-45).
//     A 429 is rejected in a guard, ahead of the RED interceptor, so the run would look green
//     and fast while measuring the rate limiter. In a split topology set it on the auth service
//     too — that is the one a load script hits first, in setup(), before anything is measured.
//   - auth.requireVerifiedEmail=false (the default) so login returns a token directly.
//
// Authoritative latency/throughput comes from the app's own Prometheus recording rules
// (route:http_request_duration_seconds:p99, job:http_request_*), never from k6 client
// timing — k6 only drives load and asserts the run was not silently degraded.

import http from 'k6/http';

export const BASE = __ENV.BASE_URL || 'http://localhost:3000';
export const JSON_HDR = { 'Content-Type': 'application/json' };

// Defaults to BASE — the monolith topology these experiments are specified against. Split out
// because `260909-2223-microservice-monorepo-migration` moves /auth/* to its own service on its
// own port, and a run against a half-migrated stack otherwise fails as an unexplained 404 storm
// on the write path. Capacity numbers must still be captured on ONE topology, not across two:
// point this elsewhere to make a script runnable, and record which topology produced the number.
export const AUTH_BASE = __ENV.AUTH_BASE_URL || BASE;

// Throwaway credential for accounts these scripts create in a load database. Same policy as
// scripts/perf-seed.ts:38-40 — overridable from the environment, and the committed default is
// self-evidently not a real secret. Passes the register DTO (min length 8).
export const LOAD_PASSWORD = __ENV.LOAD_PASSWORD || 'load-test-not-a-real-secret';

// Accounts these scripts mint. Shared prefix so a cleanup query can find them all.
export const LOAD_EMAIL_DOMAIN = __ENV.LOAD_EMAIL_DOMAIN || 'loadtest.jcool.local';

// setup() must read bodies even when the scenario sets `discardResponseBodies: true` (the read
// profiles do, to keep the generator cheap). The global flag is per-request overridable; without
// this every discovery call would come back with a null body and setup would throw on parse.
const READ_BODY = { responseType: 'text' };

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// POST /orders is guarded by a required Idempotency-Key (any UUID). A fresh one per attempt keeps
// each placement distinct — a repeated key replays the first order instead of creating one.
export function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function authHeaders(token, extra) {
  return { headers: { ...JSON_HDR, Authorization: `Bearer ${token}`, ...(extra || {}) } };
}

// k6 durations ('5m', '90s', '1m30s') → seconds. Used to turn a declared load shape into the
// number of requests it SHOULD produce, which is what the anti-false-green thresholds key on:
// a count floor that is derived from the shape survives a change to DURATION or RATE, a
// hardcoded one silently stops meaning anything.
export function toSeconds(duration) {
  if (typeof duration === 'number') return duration;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(String(duration).trim());
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    throw new Error(`unparsable k6 duration: "${duration}"`);
  }
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

// Iterations a ramping-arrival-rate shape schedules: each stage interpolates linearly from the
// previous target, so a stage is a trapezoid (a held stage — same target as the previous one —
// degenerates to a rectangle).
export function plannedRampIterations(startRate, stages) {
  let prev = startRate;
  let total = 0;
  for (const stage of stages) {
    total += ((prev + stage.target) / 2) * toSeconds(stage.duration);
    prev = stage.target;
  }
  return total;
}

/**
 * Catalog discovery for setup(). `pages` walks the paged list so a read profile can spread over a
 * WIDE key space (Experiment A); page 1 alone gives the NARROW space Experiment B needs to make a
 * real herd. Slugs come back sorted so every arm of an A/B hits an identical key set — an arm that
 * silently drew different keys is not a comparison.
 */
export function discoverSlugs({ pages = 1, pageSize = 20 } = {}) {
  const slugs = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(pages, totalPages); page++) {
    const res = http.get(`${BASE}/products?page=${page}&pageSize=${pageSize}`, READ_BODY);
    if (res.status !== 200) throw new Error(`GET /products page ${page} → ${res.status}`);
    const body = res.json();
    totalPages = body.totalPages || 1;
    for (const product of body.items || []) slugs.push(product.slug);
  }
  if (!slugs.length) throw new Error('catalog empty: run npm run db:seed:perf');
  return slugs.sort();
}

// SKU ids behind the given slugs, in slug order, so "the first SKU" is the same SKU on every run.
export function discoverSkus(slugs) {
  const skus = [];
  for (const slug of slugs) {
    const res = http.get(`${BASE}/products/${slug}`, READ_BODY);
    if (res.status !== 200) throw new Error(`GET /products/${slug} → ${res.status}`);
    for (const variant of res.json().variants || []) skus.push(variant.id);
  }
  if (!skus.length) throw new Error(`no variants under ${slugs.length} slugs: reseed the catalog`);
  return skus;
}

/**
 * Register-then-login. Register may 409 (the account survives from an earlier arm) — that is the
 * expected path on a repeat run and is not an error; only a missing token is. Returns null so the
 * caller decides whether a missing token aborts setup() or just fails a check.
 */
export function mintToken(email) {
  const body = JSON.stringify({ email, password: LOAD_PASSWORD });
  http.post(`${AUTH_BASE}/auth/register`, body, {
    ...READ_BODY,
    headers: JSON_HDR,
    tags: { name: 'POST /auth/register' },
  });
  const login = http.post(`${AUTH_BASE}/auth/login`, body, {
    ...READ_BODY,
    headers: JSON_HDR,
    tags: { name: 'POST /auth/login' },
  });
  return login.status === 200 ? login.json('accessToken') : null;
}
