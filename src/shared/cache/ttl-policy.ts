/**
 * The three windows that shape one cached entry's life, plus the single-flight bounds.
 *
 * `softTtlMs` is how long a value is served without question; `staleWindowMs` is how much longer it
 * may be served while a rebuild runs behind it; past both the key is gone and the next read has to
 * wait for Postgres.
 */
export interface TtlPolicy {
  softTtlMs: number;
  staleWindowMs: number;
  /** Upper bound on the random extra added to the hard TTL. */
  jitterMs: number;
  /** Lifetime of a rebuild lock — an upper bound on how long a crashed holder blocks the next rebuild. */
  leaseMs: number;
  /** How long a caller that lost the lock waits for the winner's value before reading through to the source. */
  waitMs: number;
}

/** Cached payload plus the instant it stops being fresh, so a read can tell fresh from stale without a second Redis round-trip. */
export interface CacheEnvelope<T> {
  data: T;
  freshUntil: number;
}

/**
 * Redis expiry for one entry. The jitter is the point: keys written together — after a cold start,
 * or the read that follows a generation bump — would otherwise expire in the same instant and send
 * one herd at Postgres per wave.
 */
export function computeHardTtlMs(policy: TtlPolicy, random: () => number = Math.random): number {
  return policy.softTtlMs + policy.staleWindowMs + Math.floor(random() * policy.jitterMs);
}

export function makeEnvelope<T>(data: T, policy: TtlPolicy, now: number = Date.now()): CacheEnvelope<T> {
  return { data, freshUntil: now + policy.softTtlMs };
}

export function isFresh(envelope: CacheEnvelope<unknown>, now: number = Date.now()): boolean {
  return now < envelope.freshUntil;
}

/** Guards against decoding a payload written before this shape existed (or by another writer) as an envelope with `freshUntil: undefined`, which would read as permanently stale. */
export function isEnvelope<T>(value: unknown): value is CacheEnvelope<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    typeof (value as CacheEnvelope<T>).freshUntil === 'number'
  );
}
