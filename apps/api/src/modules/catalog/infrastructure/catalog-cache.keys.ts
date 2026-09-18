import { createHash } from 'node:crypto';
import type { FindManyActiveCriteria } from '../application/ports';
import { UUID_PATTERN } from './drizzle-product.repository';

// The trailing `vN` is the cached payload's shape version — bump it alongside a snapshot change so
// a rolling deploy can never decode an old snapshot into a new shape. v2 added `imageAssetIds`.
const NAMESPACE = 'catalog:v2';

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
  return `${NAMESPACE}:${version}:product:${digestOf(normalizeIdOrSlug(idOrSlug))}`;
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

/**
 * Postgres compares `uuid` case-insensitively, so one product would otherwise be cached under
 * every hex-case spelling of its id. Only UUID-shaped input is folded — slugs are compared as
 * text, where case is significant and lowercasing a slug could turn a 404 into someone else's
 * product.
 */
function normalizeIdOrSlug(idOrSlug: string): string {
  return UUID_PATTERN.test(idOrSlug) ? idOrSlug.toLowerCase() : idOrSlug;
}
