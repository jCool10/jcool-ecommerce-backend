import type { DomainError } from './domain-error';

/** Explicit success/failure wrapper for expected failures the caller must branch on; default policy is to throw `DomainError` for invariant breaches and reach for `Result` only when a call-site handles failure inline. */
export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
