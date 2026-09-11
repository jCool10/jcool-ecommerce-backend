// Experiment A config — breakpoint / knee (plans/260911-0904-k6-performance-program/phase-03-breakpoint-knee.md).

import { discoverSkus, discoverSlugs, toSeconds } from '../shared/config.js';

export { BASE, JSON_HDR, authHeaders, mintToken, pick, uuidv4 } from '../shared/config.js';

// read  — wide key space, steady-state read capacity.
// mixed — 20% of arrivals run the write journey, 80% read. Run the two SEPARATELY: mixing them
//         in one run makes the bottleneck unattributable, which is the half of this experiment
//         that turns a number into an answer.
export const PROFILE = __ENV.PROFILE || 'read';

// Offered rates, one HELD step each. Each level costs STEP of wall clock, so the default ladder
// is ~35 min of holds plus ramps. Calibrate first with STEP=2m, publish only from STEP=5m.
export const LEVELS = (__ENV.LEVELS || '50,100,200,400,800,1600').split(',').map(Number);

// Held for STEP because every recording rule averages over [5m]
// (infra/prometheus/rules/slo-burn-rate.yml:20-70). A step shorter than the rule window reports a
// p99 blended with the previous step. Read each level from the LAST 60s of its hold.
export const STEP = __ENV.STEP || '5m';

// Transition between levels. Non-zero so the step change is a ramp rather than a cliff that
// momentarily starves the VU pool; short enough that it is not mistaken for measurement time.
export const RAMP = __ENV.RAMP || '30s';

// Headroom, not a target: a queued request still occupies a VU, so as the app slows k6 needs
// far more VUs than rate×latency at the healthy p99. Too few and k6 drops iterations and
// reports the GENERATOR's limit as the system's capacity.
export const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 300);
export const MAX_VUS = Number(__ENV.MAX_VUS || 2000);

export const WRITE_SHARE = Number(__ENV.WRITE_SHARE || (PROFILE === 'mixed' ? 0.2 : 0));
export const DETAIL_SHARE = Number(__ENV.DETAIL_SHARE || 0.3); // share of the READ portion

// Wide key space for this experiment — the opposite of Experiment B. Steady-state capacity, not
// herd behaviour, so reads must spread across keys and pages.
export const CATALOG_PAGES = Number(__ENV.CATALOG_PAGES || 5);
export const PAGE_SIZE = Number(__ENV.PAGE_SIZE || 20);

// Floor for the anti-false-green thresholds, as a fraction of the requests the shape schedules.
// Deliberately low: this run INTENDS to break the system, so the top steps are expected to shed.
// It catches "the write path silently stopped running", not "the system degraded".
export const MIN_OK_RATIO = Number(__ENV.MIN_OK_RATIO || 0.25);

// ramping-arrival-rate interpolates linearly from the previous target across a stage, so ONE
// stage per level is a 5-minute ramp, not a 5-minute hold. Two stages per level — reach it,
// then sit on it — is what makes the [5m] window land inside a single offered rate.
export function rampStages() {
  return LEVELS.flatMap((level) => [
    { duration: RAMP, target: level },
    { duration: STEP, target: level },
  ]);
}

export function stepBoundaries() {
  const rampSec = toSeconds(RAMP);
  const stepSec = toSeconds(STEP);
  const rows = [];
  let t = 0;
  for (const level of LEVELS) {
    t += rampSec;
    rows.push(`  ${level} req/s  hold t+${t}s → t+${t + stepSec}s`);
    t += stepSec;
  }
  return rows.join('\n');
}

export function wideKeySpace() {
  const slugs = discoverSlugs({ pages: CATALOG_PAGES, pageSize: PAGE_SIZE });
  // SKUs only matter to the mixed profile; the read profile should not pay the discovery cost.
  const skus = PROFILE === 'mixed' ? discoverSkus(slugs.slice(0, 20)) : [];
  return { slugs, skus };
}
