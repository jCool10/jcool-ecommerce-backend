// One shopper end to end on a freshly seeded stack: register, add to cart, place an order, see it
// listed, cancel it. The cancel keeps the account clear of the pending-order cap and runs the saga's
// release path through the inventory-service and the payment-service.
//
// Run:  BASE_URL=https://jcool.tech LOAD_EMAIL_DOMAIN=jcool.tech pnpm load:smoke   (production), or
//       BASE_URL=http://localhost:8080 pnpm load:smoke after pnpm db:seed plus the stock seed on the dev stack

import http from 'k6/http';
import { check } from 'k6';
import { BASE, LOAD_EMAIL_DOMAIN, authHeaders, discoverSkus, discoverSlugs, mintToken, uuidv4 } from '../shared/config.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

export function setup() {
  const [sku] = discoverSkus(discoverSlugs());
  return { sku };
}

export default function ({ sku }) {
  const token = mintToken(`smoke-${uuidv4()}@${LOAD_EMAIL_DOMAIN}`);
  if (!check(token, { 'logged in': (t) => Boolean(t) })) return;
  const auth = authHeaders(token);

  const cart = http.post(`${BASE}/cart/items`, JSON.stringify({ skuId: sku, quantity: 1 }), auth);
  if (!check(cart, { 'cart item added 200': (r) => r.status === 200 })) return;

  const placed = http.post(`${BASE}/orders`, null, authHeaders(token, { 'Idempotency-Key': uuidv4() }));
  if (!check(placed, { 'order placed 201': (r) => r.status === 201 })) return;
  const orderId = placed.json('id');

  const listed = http.get(`${BASE}/orders`, auth);
  check(listed, {
    'order listed': (r) => r.status === 200 && (r.json('items') || []).some((order) => order.id === orderId),
  });

  const cancelled = http.post(`${BASE}/orders/${orderId}/cancel`, null, auth);
  check(cancelled, { 'order cancelled 200': (r) => r.status === 200 });
}
