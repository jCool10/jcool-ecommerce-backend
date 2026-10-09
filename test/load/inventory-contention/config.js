// Experiment C config — inventory contention (plans/260911-0904-k6-performance-program/phase-04-inventory-contention.md).

import { LOAD_EMAIL_DOMAIN, discoverSkus, discoverSlugs, toSeconds } from '../shared/config.js';

export { BASE, JSON_HDR, authHeaders, mintToken, toSeconds, uuidv4 } from '../shared/config.js';

// Labels the artifact directory only. The strategy is selected by the APP's env
// (INVENTORY_LOCK_STRATEGY=pessimistic|optimistic) and must be confirmed from the startup config
// log — both strategies bump stock_levels.version, so the counter alone cannot tell them apart.
export const STRATEGY = __ENV.STRATEGY || 'pessimistic';

// c1 — abundant stock (quantity_on_hand = quantity_reserved + 1_000_000): stock can never run out,
//      so EVERY stock 409 is unambiguously contention. This is the arm that produces throughput and
//      retry-cost numbers.
// c2 — finite stock (quantity_on_hand = K on a SKU with no holds): stock 409s are a mix of CONTENDED
//      and OUT_OF_STOCK and are not interpreted. The assertions are exact and run in SQL afterwards:
//      exactly K holds, quantity_reserved == K, zero 500s.
// Every refused stock Try answers the same 409 'Insufficient stock' (checkout-order.use-case.ts),
// which is why one run cannot serve both purposes.
export const MODE = __ENV.MODE || 'c1';

// Placements per second. One run per level; the crossover between strategies is the result.
export const RATE = Number(__ENV.RATE || 40);

// c2's finite stock. Only sizes the pool; the SQL reset is what actually sets it.
export const K = Number(__ENV.K || 500);

// A buyer may hold this many unpaid orders, and a load run never pays, so every order it places stays
// PENDING until its payment deadline (an hour by default). Past the cap a buyer only gets the cap's
// 409, which `sku_cap` fails the arm on — so the pool, not the rate, bounds how many orders an arm
// can place. Mirrors MAX_PENDING_ORDERS_PER_USER.
const PENDING_CAP = 3;

// One user per VU, so no two concurrent iterations share a cart. The cart is NOT cleared by
// checkout, and POST /cart/items ACCUMULATES (cart.repository onConflict LEAST(qty + n, cap)),
// so a shared cart would make later orders reserve more than one unit each and destroy C2's
// "exactly K holds" assertion. maxVUs is pinned to the pool for the same reason: k6 must drop
// an iteration rather than hand a second VU someone else's cart.
//
// c1 places every attempt, so RATE × DURATION must fit in PENDING_CAP × POOL: the default run is
// short and the default pool grows with the rate (800 accounts at 40/s). c2 needs enough buyers to
// take all K units with headroom for the ones refused on contention: 200 for K = 500.
export const DURATION = __ENV.DURATION || (MODE === 'c2' ? '5m' : '60s');
export const POOL = Number(
  __ENV.POOL ||
    (MODE === 'c2'
      ? Math.ceil((K / PENDING_CAP) * 1.2)
      : Math.ceil((RATE * toSeconds(DURATION)) / PENDING_CAP)),
);

if (MODE === 'c1' && RATE * toSeconds(DURATION) > PENDING_CAP * POOL) {
  throw new Error(
    `c1 offers ${RATE * toSeconds(DURATION)} orders but ${POOL} buyers can hold only ${PENDING_CAP * POOL}: ` +
      'shorten DURATION or raise POOL',
  );
}
if (MODE === 'c2' && PENDING_CAP * POOL < K) {
  throw new Error(`c2 needs at least ${Math.ceil(K / PENDING_CAP)} buyers to take K=${K} units, got POOL=${POOL}`);
}

// Pending orders outlive the arm, so a prefix reused within the payment deadline starts every buyer
// already at the cap. Give each arm its own (e.g. EMAIL_PREFIX=ct-c1-pess-40).
export const EMAIL_PREFIX = __ENV.EMAIL_PREFIX || 'ct';

// Stable within an arm so the setup's register 409s and logs in on a rerun instead of minting a fresh
// argon2 hash for every account.
export function poolEmail(i) {
  return `${EMAIL_PREFIX}-${i}@${LOAD_EMAIL_DOMAIN}`;
}

// The ONE contended SKU. Pinned via SKU_ID once chosen so every arm targets the same row —
// record it in rig.md. Without it, the first SKU of the first slug in sorted order is used,
// which is deterministic but silently follows a reseed. c2 needs a SKU no earlier arm holds.
export function contendedSku() {
  if (__ENV.SKU_ID) return __ENV.SKU_ID;
  return discoverSkus(discoverSlugs({ pages: 1, pageSize: 20 }).slice(0, 1))[0];
}
