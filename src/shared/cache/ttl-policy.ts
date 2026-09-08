/**
 * `softTtlMs` is how long a value is served without question; `staleWindowMs` is how much longer it
 * may be served while a rebuild runs behind it; past both the key is gone and the next read has to
 * wait for Postgres.
 */
export interface TtlPolicy {
  softTtlMs: number;
  staleWindowMs: number;
  jitterMs: number;
  /** Lifetime of a rebuild lock — an upper bound on how long a crashed holder blocks the next rebuild. */
  leaseMs: number;
  /** How long a caller that lost the lock waits for the winner's value before reading through to the source. */
  waitMs: number;
}

export interface CacheEnvelope<T> {
  data: T;
  freshUntil: number;
}

/**
 * The jitter is the point: keys written together — after a cold start, or the read that follows a
 * generation bump — would otherwise expire in the same instant and send one herd at Postgres.
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

/**
 * Guards against decoding a pre-envelope payload as an envelope with `freshUntil: undefined`, which
 * would read as permanently stale.
 */
export function isEnvelope<T>(value: unknown): value is CacheEnvelope<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    typeof (value as CacheEnvelope<T>).freshUntil === 'number'
  );
}
