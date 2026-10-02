import { createHash } from 'node:crypto';
import type { FindManyActiveCriteria } from '../../application/catalog/ports';

// The trailing `vN` is the cached payload's shape version — bump it alongside a snapshot change so
// a rolling deploy can never decode an old snapshot into a new shape. v2 added `imageAssetIds`;
// v3 carries snowflake ids.
const NAMESPACE = 'catalog:v3';

/**
 * Generation counter mixed into every catalog key: one INCR after any admin write strands the
 * whole generation in O(1) (no SCAN/KEYS), and orphans die on their own TTL. Coarser than
 * targeted deletes but complete — a cached detail embeds its category's name and slug, and a
 * rename leaves the old slug addressable, so targeted deletes would have to fan out.
 *
 * This key carries no TTL and must never be evicted while data keys survive: losing it rewinds
 * the generation to 0 and re-exposes entries a write already invalidated. Keep Redis off any
 * `allkeys-*` maxmemory policy, or give this key its own non-evictable store.
 */
export const CATALOG_CACHE_VERSION_KEY = `${NAMESPACE}:ver`;

export function productDetailKey(version: number, idOrSlug: string): string {
  // Hashed for the same reason `q` is below: the path segment is free-form user text, so it is
  // unbounded in length and can carry the `:` that shapes the key (and the `:lock` suffix the
  // single-flight lock appends to it).
  return `${NAMESPACE}:${version}:product:${digestOf(idOrSlug)}`;
}

export function productListKey(version: number, criteria: FindManyActiveCriteria): string {
  // `satisfies Required<...>` is the point of the literal: adding a field to the criteria (a sort
  // order, say) fails to compile here instead of silently serving one cached page for every value
  // of the new field. Built in one place, so its key order — and the digest — is stable.
  const fingerprint = {
    page: criteria.page,
    pageSize: criteria.pageSize,
    // Absent and empty collapse to one key on purpose: the adapter treats both as "no filter".
    categorySlug: criteria.categorySlug ?? '',
    q: criteria.q ?? '',
  } satisfies Required<FindManyActiveCriteria>;

  // Hashed, not interpolated: `q` is free-form user text, so it is unbounded in length and can
  // carry the `:` that shapes the key.
  return `${NAMESPACE}:${version}:list:${digestOf(JSON.stringify(fingerprint))}`;
}

function digestOf(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
