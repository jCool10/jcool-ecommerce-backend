import { createHash } from 'node:crypto';
import type { FindManyActiveCriteria } from '../application/ports';
import { UUID_PATTERN } from './drizzle-product.repository';

// The trailing `vN` is the cached payload's shape version — bump it alongside a snapshot change so
// a rolling deploy can never decode an old snapshot into a new shape. v2 added `imageAssetIds`.
const NAMESPACE = 'catalog:v2';

/**
 * Generation counter mixed into every catalog key. One INCR after any admin write makes the
 * whole cached generation unreachable in O(1) — no SCAN, no KEYS (which blocks the server) —
 * and the orphaned keys die on their own TTL. Coarser than deleting the keys a write actually
 * touched, but complete: a product's cached detail also embeds its category's name and slug,
 * and a slug rename leaves the old slug's key addressable, so targeted deletes would have to
 * fan out across relationships to stay correct.
 *
 * This key carries no TTL and must never be evicted while data keys survive: losing it rewinds
 * the generation to 0 and re-exposes entries a write already invalidated. Keep Redis without a
 * `maxmemory` eviction policy that can reclaim it (`allkeys-*`), or give this key its own
 * non-evictable store.
 */
export const CATALOG_CACHE_VERSION_KEY = `${NAMESPACE}:ver`;

export function productDetailKey(version: number, idOrSlug: string): string {
  return `${NAMESPACE}:${version}:product:${normalizeIdOrSlug(idOrSlug)}`;
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
  const digest = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 32);
  return `${NAMESPACE}:${version}:list:${digest}`;
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
