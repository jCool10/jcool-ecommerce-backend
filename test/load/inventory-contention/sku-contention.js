// Experiment C — inventory contention: optimistic vs pessimistic on ONE SKU.
//
// N concurrent buyers against a single SKU under both reservation strategies at identical offered
// load. The claim being measured is NOT "our lock prevents oversell" — the database already does
// that (stock.schema.ts, check ck_stock_no_oversell), and a wrong app-layer lock would be REJECTED by
// Postgres and surface as a 500, not as an oversell. The publishable claim is:
//
//   Under N-way contention on one SKU, both strategies keep the DB invariant intact and answer
//   contention with a clean 409 and overload with a 503 carrying Retry-After, never a 500.
//   Optimistic buys X throughput at Y% 409 cost.
//
// Checkout is a saga: the stock Try runs under CHECKOUT_TRY_TIMEOUT_MS, and a Try that outlives it
// answers 503 (as does a lost race with the saga runner, or the gateway's write freeze). So 503 is
// counted apart from 500: `sku_500` is thresholded to 0 — ANY 500 or transport failure is the
// failure signal, and a ck_stock_no_oversell violation is a bug report, not a benchmark result —
// while `sku_503` above 5% of attempts marks the arm as past its breaking point: overloaded, not
// publishable. CHECKOUT_WRITE_FREEZE must be off, or every attempt is a gateway 503.
//
// Each iteration is exactly ONE `POST /orders`. The cart is loaded once per pooled user in
// setup() and checkout does not clear it, so every order reserves exactly one unit of the
// contended SKU for the whole run — which is what makes C2's "exactly K holds" assertion exact.
// Registration and login also happen only in setup(): minting tokens per iteration would make
// argon2 the bottleneck and turn this into a rerun of Experiment A.
//
// A placed order stays PENDING, holding its unit, until its payment deadline: nothing here pays.
// So a buyer can place at most 3 orders (the pending cap), and the cap's own 409 is counted apart in
// `sku_cap`. c1 sizes the pool so no buyer ever reaches it and thresholds it to 0, keeping every
// stock 409 a contention 409; in c2 buyers reach it once stock runs out, which is expected there.
//
// Preconditions: see test/load/shared/config.js. Plus, PER ARM, a fresh EMAIL_PREFIX (earlier arms'
// orders still count against their buyers' cap) and a reset of the contended SKU. Holds from earlier
// arms stay HELD until their deadline, so quantity_reserved is never written by hand:
//
//   -- MODE=c1 (abundant → every stock 409 is contention); capture `version` before and after
//   UPDATE stock_levels SET quantity_on_hand = quantity_reserved + 1000000 WHERE variant_id = '<SKU_ID>';
//   -- MODE=c2 (finite, K=500 → the invariant assertion), on a SKU no earlier arm holds
//   UPDATE stock_levels SET quantity_on_hand = 500 WHERE variant_id = '<FRESH_SKU_ID>';
//
// After a c2 arm, assert in SQL (no metric exists for either): quantity_reserved = 500, and exactly
// 500 HELD reservations for the variant.
//   SELECT quantity_on_hand, quantity_reserved, version FROM stock_levels WHERE variant_id = '<FRESH_SKU_ID>';
//   SELECT count(*) FROM reservations WHERE variant_id = '<FRESH_SKU_ID>' AND status = 'HELD';
// The `version` delta across a c1 optimistic arm is a direct count of successful CAS bumps — the
// closest thing to a retry metric available without app changes.
//
// Run:  SKU_ID=<id> STRATEGY=pessimistic RATE=40 EMAIL_PREFIX=ct-c1-pess-40 npm run load:sku-contention
//       SKU_ID=<fresh id> STRATEGY=optimistic MODE=c2 RATE=80 EMAIL_PREFIX=ct-c2-opt-80 npm run load:sku-contention
// Tunables (env): BASE_URL, SKU_ID, STRATEGY, MODE, RATE, DURATION, POOL, K, EMAIL_PREFIX,
//                 LOAD_PASSWORD, OUT_DIR

import http from 'k6/http';
import exec from 'k6/execution';
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

const PENDING_CAP_MESSAGE = 'Too many pending orders';

const sku201 = new Counter('sku_201'); // holds actually taken — the headline denominator
const sku409 = new Counter('sku_409'); // stock refused: contention (c1) / contention+sold-out (c2)
const skuCap = new Counter('sku_cap'); // the pending cap's 409, never stock — c1 MUST keep it at 0
const sku503 = new Counter('sku_503'); // Try timeout, lost race with the runner, or the write freeze
const sku503Rate = new Rate('sku_503_rate');
const sku500 = new Counter('sku_500'); // MUST stay 0 — any other 5xx, or transport failure (status 0)
// Anything else: a 400 "Cart is empty" means the cart setup silently failed and the run is measuring
// an empty-cart rejection, not contention; a 401 means the token pool expired; a 429 means
// THROTTLE_ENABLED was left on and POST /orders is capped at 10/60s PER USER.
const skuUnexpected = new Rate('sku_unexpected');

export const options = {
  scenarios: {
    contention: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // Capped at the pool: no more iterations can run at once than there are buyers (see below).
      // k6 dropping an iteration is the correct failure here, and it is thresholded below.
      preAllocatedVUs: POOL,
      maxVUs: POOL,
    },
  },
  // Registering POOL accounts costs one argon2 hash each, plus a cart reset and a cart load.
  setupTimeout: __ENV.SETUP_TIMEOUT || '10m',
  thresholds: {
    sku_500: ['count==0'],
    sku_503_rate: ['rate<0.05'],
    ...(MODE === 'c1' ? { sku_cap: ['count==0'] } : {}),
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
  // Round-robin over buyers by global iteration, so each places an equal share of the attempts and
  // c1's sizing keeps every one of them under the cap. No more than POOL iterations run at once, so
  // two concurrent iterations never share a buyer.
  const buyer = exec.scenario.iterationInTest % data.tokens.length;
  const auth = authHeaders(data.tokens[buyer]);
  const res = http.post(`${BASE}/orders`, null, {
    headers: { ...auth.headers, ...JSON_HDR, 'Idempotency-Key': uuidv4() },
    tags: { name: 'POST /orders' },
  });

  const capped = res.status === 409 && String(res.body).includes(PENDING_CAP_MESSAGE);
  if (res.status === 201) sku201.add(1);
  else if (capped) skuCap.add(1);
  else if (res.status === 409) sku409.add(1);
  else if (res.status === 503) sku503.add(1);
  else if (res.status >= 500 || res.status === 0) sku500.add(1); // status 0 = connection reset/crash
  sku503Rate.add(res.status === 503);
  skuUnexpected.add(![201, 409, 503].includes(res.status));

  check(res, {
    'status is 201, 409 or 503 (never 500)': (r) => r.status === 201 || r.status === 409 || r.status === 503,
    '503 carries Retry-After': (r) => r.status !== 503 || Boolean(r.headers['Retry-After']),
  });
}
