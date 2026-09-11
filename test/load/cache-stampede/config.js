// Experiment B config — cache stampede (plans/260911-0904-k6-performance-program/phase-02-cache-stampede.md).
//
// Everything that must be IDENTICAL across the three arms lives here, because the whole
// experiment is a comparison: arms that drew different keys, or were offered different load,
// are not comparable and the source-read ratio between them means nothing.

import { discoverSlugs } from '../shared/config.js';

export { BASE, JSON_HDR, toSeconds } from '../shared/config.js';

// Offered load. Held flat (constant-arrival-rate) so latency rising in the unprotected arm
// cannot throttle the generator — a closed model would quietly equalise the arms.
export const RATE = Number(__ENV.RATE || 400);
export const DURATION = __ENV.DURATION || '6m'; // 1m warm-up (discarded at capture) + 5m measured

// preAllocatedVUs must cover RATE × the SLOWEST arm's response time. The unprotected arm is the
// slow one by construction, so size for it or k6 drops iterations and voids the comparison.
export const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 200);
export const MAX_VUS = Number(__ENV.MAX_VUS || 500);

// 70/30 list/detail, matching k6/baseline.js's read mix so the two are on the same footing.
export const DETAIL_SHARE = Number(__ENV.DETAIL_SHARE || 0.3);

// NARROW key space on purpose — the opposite of Experiment A. 400 req/s spread over the whole
// catalog makes no key hot enough to stampede; concentrated on a handful it makes a real herd.
export const SLUG_COUNT = Number(__ENV.SLUG_COUNT || 5);
export const PAGE_SIZE = Number(__ENV.PAGE_SIZE || 20);

// Floor for the "this run actually exercised both routes" thresholds, as a fraction of the
// requests the load shape schedules. Below this the run degraded (404s on a stale slug set,
// 5xx, or a generator that could not keep up) and must fail rather than publish green.
export const MIN_OK_RATIO = Number(__ENV.MIN_OK_RATIO || 0.9);

// Which arm this run is: protected | no-swr | unprotected. Recorded in the summary path only —
// the arm is actually selected by the app's .env (CACHE_STALE_WINDOW_SEC / CACHE_TTL_JITTER_SEC /
// CACHE_LOCK_WAIT_MS), never by k6. Confirm the knob took effect from catalog_cache_operations_total
// before trusting an arm; a silently-ignored env var produces three identical arms.
export const ARM = __ENV.ARM || 'protected';

// Page 1 only, first SLUG_COUNT slugs in sorted order — deterministic across arms and runs.
export function narrowKeySpace() {
  return discoverSlugs({ pages: 1, pageSize: PAGE_SIZE }).slice(0, SLUG_COUNT);
}
