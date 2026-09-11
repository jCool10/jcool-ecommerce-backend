// Experiment C config — inventory contention (plans/260911-0904-k6-performance-program/phase-04-inventory-contention.md).

import { LOAD_EMAIL_DOMAIN, discoverSkus, discoverSlugs } from '../shared/config.js';

export { BASE, JSON_HDR, authHeaders, mintToken, toSeconds, uuidv4 } from '../shared/config.js';

// Labels the artifact directory only. The strategy is selected by the APP's env
// (INVENTORY_LOCK_STRATEGY=pessimistic|optimistic) and must be confirmed from the startup config
// log — both strategies bump stock_levels.version, so the counter alone cannot tell them apart.
export const STRATEGY = __ENV.STRATEGY || 'pessimistic';

// c1 — abundant stock (quantity_on_hand = 1_000_000): stock can never run out, so EVERY 409 is
//      unambiguously contention. This is the arm that produces throughput and retry-cost numbers.
// c2 — finite stock (quantity_on_hand = K): 409s are a mix of CONTENDED and OUT_OF_STOCK and are
//      not interpreted. The assertions are exact and run in SQL afterwards: exactly K holds,
//      quantity_reserved == K, zero 5xx.
// Both map to the same ConflictException → 409 (checkout-order.use-case.ts:76-82), which is why
// one run cannot serve both purposes.
export const MODE = __ENV.MODE || 'c1';

// Placements per second. One run per level; the crossover between strategies is the result.
export const RATE = Number(__ENV.RATE || 40);
export const DURATION = __ENV.DURATION || '5m'; // the [5m] recording-rule window

// One user per VU, so no two concurrent iterations share a cart. The cart is NOT cleared by
// checkout, and POST /cart/items ACCUMULATES (cart.repository onConflict LEAST(qty + n, cap)),
// so a shared cart would make later orders reserve more than one unit each and destroy C2's
// "exactly K holds" assertion. maxVUs is pinned to the pool for the same reason: k6 must drop
// an iteration rather than hand a second VU someone else's cart.
export const POOL = Number(__ENV.POOL || 100);

export const EMAIL_PREFIX = __ENV.EMAIL_PREFIX || 'ct';

// Stable across runs so repeat arms reuse the same accounts and carts (register 409s, login
// succeeds) instead of minting a fresh argon2 hash per arm.
export function poolEmail(i) {
  return `${EMAIL_PREFIX}-${i}@${LOAD_EMAIL_DOMAIN}`;
}

// The ONE contended SKU. Pinned via SKU_ID once chosen so every arm targets the same row —
// record it in rig.md. Without it, the first SKU of the first slug in sorted order is used,
// which is deterministic but silently follows a reseed.
export function contendedSku() {
  if (__ENV.SKU_ID) return __ENV.SKU_ID;
  return discoverSkus(discoverSlugs({ pages: 1, pageSize: 20 }).slice(0, 1))[0];
}
