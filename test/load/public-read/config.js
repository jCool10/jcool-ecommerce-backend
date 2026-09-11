// Public-endpoint read profile — config.
//
// This is NOT one of the three performance experiments (test/load/{breakpoint,cache-stampede,
// inventory-contention}). Those are specified against the local compose stack with
// THROTTLE_ENABLED=false and Prometheus as the authoritative latency source. Neither holds for a
// deployed public URL, so a different, deliberately smaller thing is measured here:
//
//   steady — offered load kept UNDER the app-wide IP throttle, so the numbers describe the app
//            serving traffic rather than the rate limiter shedding it.
//   burst  — offered load deliberately ABOVE it, to characterise the limiter itself: where 429
//            begins, and that shedding stays cheap instead of falling over.
//
// Client-side timing here includes the WAN round trip to the deployment region, so absolute
// latency is NOT comparable to a localhost run. GET /health/live is sampled alongside the catalog
// routes as the floor: it does no database or cache work, so (catalog − health) is the part of the
// number that belongs to the application.

export { BASE, JSON_HDR } from '../shared/config.js';

// steady | burst
export const PROFILE = __ENV.PROFILE || 'steady';

// GLOBAL_THROTTLERS default tier: 100 requests / 60s, keyed by IP, applied app-wide
// (src/shared/infrastructure/throttler/throttler.constants.ts). 3 per 2s = 90/min leaves headroom
// for the setup() discovery call, which is charged to the same bucket.
//
// k6 requires an INTEGER rate, so a sub-1/s offered load is expressed as a count over a wider
// timeUnit rather than as a fraction.
export const STEADY_RATE = Number(__ENV.STEADY_RATE || 3);
export const STEADY_TIME_UNIT = __ENV.STEADY_TIME_UNIT || '2s';
export const STEADY_DURATION = __ENV.STEADY_DURATION || '4m';

// Above the limit on purpose. The first ~100 requests of the window are served, the rest are shed.
export const BURST_RATE = Number(__ENV.BURST_RATE || 20);
export const BURST_TIME_UNIT = __ENV.BURST_TIME_UNIT || '1s';
export const BURST_DURATION = __ENV.BURST_DURATION || '1m';

export const RATE = PROFILE === 'burst' ? BURST_RATE : STEADY_RATE;
export const TIME_UNIT = PROFILE === 'burst' ? BURST_TIME_UNIT : STEADY_TIME_UNIT;
export const DURATION = PROFILE === 'burst' ? BURST_DURATION : STEADY_DURATION;

// Small: the offered rate is small. Sized for the burst profile, where queued iterations pile up.
export const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 20);
export const MAX_VUS = Number(__ENV.MAX_VUS || 60);

// Round-robin rather than random, so a 4-minute run at 1.5/s still covers all three routes evenly —
// at this few iterations a random draw has visible sampling error.
export const ROUTES = ['list', 'detail', 'health'];
