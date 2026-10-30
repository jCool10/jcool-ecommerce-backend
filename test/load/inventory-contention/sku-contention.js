// Experiment C — inventory contention: optimistic vs pessimistic on ONE SKU.
//
// N concurrent buyers against a single SKU under both reservation strategies at identical offered
// load. The claim being measured is NOT "our lock prevents oversell" — the database already does
// that (the inventory-service's stock.schema.ts, check ck_stock_no_oversell), and a wrong app-layer lock would be
// REJECTED by Postgres and surface as a 500, not as an oversell. The publishable claim is:
//
//   Under N-way contention on one SKU, both strategies keep the DB invariant intact and surface
//   contention as a clean 409, never a 500. Optimistic buys X throughput at Y% 409-retry cost.
//
// So `sku_500` is thresholded to 0: any 5xx but 503 is the failure signal, and a
// ck_stock_no_oversell violation is a bug report, not a benchmark result. A 503 is a Try that
// outlived its budget (CHECKOUT_TRY_TIMEOUT_MS) on a hot row: tolerated under 5% of the attempts that
// reach stock (`sku_503`, cap 409s left out).
//
// Each iteration is exactly ONE `POST /orders`. The cart is loaded once per pooled user in
// setup() and checkout does not clear it, so every order reserves exactly one unit of the
// contended SKU for the whole run — which is what makes C2's "exactly K holds" assertion exact.
// Registration and login also happen only in setup(): minting tokens per iteration would make
// argon2 the bottleneck and turn this into a rerun of Experiment A.
//
// A user has at most 3 orders in flight (RESERVING, PENDING, CONFIRMING), and nothing pays in a
// load run, so every account stops at 3 placed orders. Those 409s never reach stock and are
// counted apart (`sku_409_cap`). POOL × 3 must exceed the holds a c2 arm can take, or the cap
// answers before stock runs out; a c1 arm reaches the cap by design.
//
// Preconditions: see test/load/shared/config.js. Checkout runs on the saga, so Temporal must be
// up and CHECKOUT_WRITE_FREEZE off (the gateway answers every POST /orders 503 while frozen).
// Plus, PER ARM, reset the contended SKU first — a load run never releases its holds, so a
// carried-over quantity_reserved makes the next arm start partly sold out and look slower for no
// reason. PENDING orders of an earlier arm keep their accounts at the cap until their payment
// deadline, so give each arm its own EMAIL_PREFIX. Stock lives in the inventory-service's database
// (compose: postgresql://inventory:inventory@localhost:5435/inventory), orders in the api's (5433):
//
//   -- inventory-postgres
//   DELETE FROM reservation_orders WHERE order_id IN (SELECT order_id FROM reservations WHERE variant_id = '<SKU_ID>');
//   DELETE FROM reservations WHERE variant_id = '<SKU_ID>';
//   -- MODE=c1 (abundant → every stock 409 is contention)
//   UPDATE stock_levels SET quantity_on_hand = 1000000, quantity_reserved = 0, version = 0
//    WHERE variant_id = '<SKU_ID>';
//   -- MODE=c2 (finite, K=500 → the invariant assertion)
//   UPDATE stock_levels SET quantity_on_hand = 500, quantity_reserved = 0, version = 0
//    WHERE variant_id = '<SKU_ID>';
//   -- the api's postgres
//   DELETE FROM orders WHERE status IN ('RESERVING', 'REJECTED')
//    AND id IN (SELECT order_id FROM order_items WHERE sku_id = '<SKU_ID>');
//
// After a c2 arm, assert in SQL on inventory-postgres (no metric exists for any of them); the last
// two must both equal K, one single-line order per hold:
//   SELECT quantity_on_hand, quantity_reserved, version FROM stock_levels WHERE variant_id = '<SKU_ID>';
//   SELECT count(*) FROM reservations WHERE variant_id = '<SKU_ID>' AND status = 'HELD';
//   SELECT count(*) FROM reservation_orders WHERE status = 'HELD'
//    AND order_id IN (SELECT order_id FROM reservations WHERE variant_id = '<SKU_ID>');
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
const sku409Cap = new Counter('sku_409_cap'); // the per-user in-flight cap; never reached stock
const sku503 = new Rate('sku_503'); // a Try past its budget
const sku500 = new Counter('sku_500'); // MUST stay 0 — any other 5xx, or transport failure (status 0)
// Anything not 201/409/503: a 400 "Cart is empty" means the cart setup silently failed and the run
// is measuring an empty-cart rejection, not contention; a 401 means the token pool expired; a 429
// means THROTTLE_ENABLED was left on and POST /orders is capped at 10/60s PER USER.
const skuUnexpected = new Rate('sku_unexpected');
const CAP_MESSAGE = /too many pending orders/i;

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
    sku_500: ['count==0'],
    sku_503: ['rate<0.05'],
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
      ` — confirm INVENTORY_LOCK_STRATEGY from the inventory-service startup log, not from this label`,
  );
  return { skuId, tokens };
}

export default function (data) {
  // __VU is 1..maxVUs and maxVUs == POOL, so this is a bijection: one user, one cart, one VU.
  const auth = authHeaders(data.tokens[(__VU - 1) % data.tokens.length]);
  const res = http.post(`${BASE}/orders`, null, {
    headers: { ...auth.headers, ...JSON_HDR, 'Idempotency-Key': uuidv4() },
    tags: { name: 'POST /orders' },
    responseType: 'text',
  });

  const isCap = res.status === 409 && CAP_MESSAGE.test(res.body);
  if (res.status === 201) sku201.add(1);
  else if (isCap) sku409Cap.add(1);
  else if (res.status === 409) sku409.add(1);
  else if (res.status === 0 || (res.status >= 500 && res.status !== 503)) sku500.add(1); // 0 = connection reset/crash
  // Over the attempts that reached stock only: a c1 arm is mostly cap 409s, which would dilute the rate.
  if (!isCap) sku503.add(res.status === 503);
  skuUnexpected.add(res.status !== 201 && res.status !== 409 && res.status !== 503);

  check(res, {
    'status is 201, 409 or 503 (never another 5xx)': (r) => r.status === 201 || r.status === 409 || r.status === 503,
  });
}
