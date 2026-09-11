// Experiment C — inventory contention: optimistic vs pessimistic on ONE SKU.
//
// N concurrent buyers against a single SKU under both reservation strategies at identical offered
// load. The claim being measured is NOT "our lock prevents oversell" — the database already does
// that (inventory.schema.ts:40, check ck_stock_no_oversell), and a wrong app-layer lock would be
// REJECTED by Postgres and surface as a 500, not as an oversell. The publishable claim is:
//
//   Under N-way contention on one SKU, both strategies keep the DB invariant intact and surface
//   contention as a clean 409, never a 5xx. Optimistic buys X throughput at Y% 409-retry cost.
//
// So `sku_5xx` is thresholded to 0: ANY 5xx is the failure signal, and a ck_stock_no_oversell
// violation is a bug report, not a benchmark result.
//
// Each iteration is exactly ONE `POST /orders`. The cart is loaded once per pooled user in
// setup() and checkout does not clear it, so every order reserves exactly one unit of the
// contended SKU for the whole run — which is what makes C2's "exactly K holds" assertion exact.
// Registration and login also happen only in setup(): minting tokens per iteration would make
// argon2 the bottleneck and turn this into a rerun of Experiment A.
//
// Preconditions: see test/load/shared/config.js. Plus, PER ARM, reset the contended SKU first —
// a load run never releases its holds, so a carried-over quantity_reserved makes the next arm
// start partly sold out and look slower for no reason:
//
//   -- MODE=c1 (abundant → every 409 is contention)
//   UPDATE stock_levels SET quantity_on_hand = 1000000, quantity_reserved = 0, version = 0
//    WHERE sku_id = '<SKU_ID>';
//   -- MODE=c2 (finite, K=500 → the invariant assertion)
//   UPDATE stock_levels SET quantity_on_hand = 500, quantity_reserved = 0, version = 0
//    WHERE sku_id = '<SKU_ID>';
//
// After a c2 arm, assert in SQL (no metric exists for either):
//   SELECT quantity_on_hand, quantity_reserved, version FROM stock_levels WHERE sku_id = '<SKU_ID>';
//   SELECT count(*) FROM reservations WHERE sku_id = '<SKU_ID>' AND status = 'HELD';
// The `version` delta across a c1 optimistic arm is a direct count of successful CAS bumps — the
// closest thing to a retry metric available without app changes. Capture it before and after.
//
// Run:  SKU_ID=<uuid> STRATEGY=pessimistic RATE=40 npm run load:sku-contention
//       SKU_ID=<uuid> STRATEGY=optimistic MODE=c2 RATE=80 npm run load:sku-contention
// Tunables (env): BASE_URL, SKU_ID, STRATEGY, MODE, RATE, DURATION, POOL, EMAIL_PREFIX,
//                 LOAD_PASSWORD, OUT_DIR

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import {
  BASE,
  DURATION,
  JSON_HDR,
  MODE,
  POOL,
  RATE,
  STRATEGY,
  authHeaders,
  contendedSku,
  mintToken,
  poolEmail,
  uuidv4,
} from './config.js';

const sku201 = new Counter('sku_201'); // holds actually taken — the headline denominator
const sku409 = new Counter('sku_409'); // contention (c1) / contention+sold-out (c2)
const sku5xx = new Counter('sku_5xx'); // MUST stay 0 — 5xx or transport failure (status 0)
// Anything not 201/409: a 400 "Cart is empty" means the cart setup silently failed and the run is
// measuring an empty-cart rejection, not contention; a 401 means the token pool expired; a 429
// means THROTTLE_ENABLED was left on and POST /orders is capped at 10/60s PER USER.
const skuUnexpected = new Rate('sku_unexpected');

export const options = {
  scenarios: {
    contention: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // Pinned to the pool: one user per VU (see config.js). k6 dropping an iteration is the
      // correct failure here, and it is thresholded below.
      preAllocatedVUs: POOL,
      maxVUs: POOL,
    },
  },
  // Registering POOL accounts costs one argon2 hash each, plus a cart reset and a cart load.
  setupTimeout: __ENV.SETUP_TIMEOUT || '10m',
  thresholds: {
    sku_5xx: ['count==0'],
    sku_unexpected: ['rate<0.01'],
    // Anti-false-green: a run where every attempt 409s from the first second is not a throughput
    // measurement. In c1 that means the reset SQL was not applied; in c2 it means K was consumed
    // before the window opened. Either way the arm must fail rather than publish a zero.
    sku_201: ['count>0'],
    // Offered load must match across strategies or the comparison is void.
    dropped_iterations: ['count==0'],
    // http_req_duration deliberately NOT thresholded: authoritative latency is
    // route:http_request_duration_seconds:p99{route="/orders"} from Prometheus.
  },
};

export function setup() {
  const skuId = contendedSku();
  const tokens = [];
  for (let i = 0; i < POOL; i++) {
    const email = poolEmail(i);
    const token = mintToken(email);
    if (!token) throw new Error(`no token for ${email}: check THROTTLE_ENABLED=false and LOAD_PASSWORD`);
    const auth = authHeaders(token);

    // Reset then load exactly one unit. The reset is mandatory: POST /cart/items accumulates, so
    // an account reused from an earlier arm would carry that arm's quantity into this one and
    // every order would reserve more than one unit.
    http.del(`${BASE}/cart`, null, auth);
    const added = http.post(`${BASE}/cart/items`, JSON.stringify({ skuId, quantity: 1 }), {
      ...auth,
      responseType: 'text',
    });
    if (added.status !== 200 && added.status !== 201) {
      throw new Error(`cart load failed for ${email}: ${added.status} ${added.body}`);
    }
    // Assert the cart is exactly one line of one unit of the contended SKU, from the response the
    // add already returned. Without this, a silently wrong cart turns every 409 into noise and the
    // c2 hold count into a number that cannot be reconciled with the attempt count.
    const lines = added.json().items || [];
    const line = lines.find((l) => l.skuId === skuId);
    if (lines.length !== 1 || !line || line.quantity !== 1) {
      throw new Error(`cart for ${email} is not 1×${skuId}: ${JSON.stringify(lines)}`);
    }
    tokens.push(token);
  }
  console.log(
    `strategy=${STRATEGY} mode=${MODE} sku=${skuId} rate=${RATE}/s duration=${DURATION} pool=${POOL}` +
      ` — confirm INVENTORY_LOCK_STRATEGY from the app startup log, not from this label`,
  );
  return { skuId, tokens };
}

export default function (data) {
  // __VU is 1..maxVUs and maxVUs == POOL, so this is a bijection: one user, one cart, one VU.
  const auth = authHeaders(data.tokens[(__VU - 1) % data.tokens.length]);
  const res = http.post(`${BASE}/orders`, null, {
    headers: { ...auth.headers, ...JSON_HDR, 'Idempotency-Key': uuidv4() },
    tags: { name: 'POST /orders' },
  });

  if (res.status === 201) sku201.add(1);
  else if (res.status === 409) sku409.add(1);
  else if (res.status >= 500 || res.status === 0) sku5xx.add(1); // status 0 = connection reset/crash
  skuUnexpected.add(res.status !== 201 && res.status !== 409);

  check(res, { 'status is 201 or 409 (never 5xx)': (r) => r.status === 201 || r.status === 409 });
}
