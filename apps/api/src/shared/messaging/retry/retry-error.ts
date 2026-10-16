import { toError } from '@jcool/kernel';

const LAST_ERROR_MAX_LENGTH = 1_000;
const MAX_CAUSE_DEPTH = 10;

/**
 * A query wrapper's message and stack carry the statement's parameters, which here are the payload.
 * Anything this module logs, stores or hands back to the transport goes through this first.
 */
export function rootCause(error: unknown): Error {
  let root = toError(error);
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && root.cause instanceof Error; depth++) root = root.cause;
  return root;
}

/** Stored, and printed by the replay CLI. */
export function lastErrorText(error: unknown): string {
  const root = rootCause(error);
  return `${root.name}: ${root.message}`.slice(0, LAST_ERROR_MAX_LENGTH);
}

/** SQLSTATE class 22: the row itself is unstorable, so writing it again can only fail again. */
export function isDataException(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && code.startsWith('22')) return true;
    current = cause;
  }
  return false;
}
