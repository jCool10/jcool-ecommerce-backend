import type { DomainError } from './domain-error';

/**
 * Opt-in success/failure wrapper for *expected* failures the caller must branch
 * on (e.g. an illegal state transition that is a normal outcome, not a bug).
 *
 * Default policy: throw `DomainError` for invariant breaches. Reach for `Result`
 * only when the call-site needs to handle failure inline rather than let it
 * propagate — keeps the happy path free of try/catch noise where that matters.
 */
export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
