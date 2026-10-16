import { describe, expect, it } from 'vitest';
import { isDataException, lastErrorText, rootCause } from './retry-error';

// Shaped like drizzle's DrizzleQueryError over a pg DatabaseError: the wrapper's message carries the
// statement and its parameters, the driver error underneath carries only the server's verdict.
function queryError(code: string, message: string): Error {
  const driver = Object.assign(new Error(message), { name: 'error', code });
  return new Error(
    `Failed query: insert into "consumer_retries" values ($1, $2)\nparams: 42,{"email":"buyer@x.test"}`,
    {
      cause: driver,
    },
  );
}

describe('lastErrorText', () => {
  it('keeps only the root cause, so a wrapped query never leaks its parameters', () => {
    const text = lastErrorText(queryError('57P01', 'terminating connection due to administrator command'));

    expect(text).toBe('error: terminating connection due to administrator command');
    expect(text).not.toContain('buyer@x.test');
    expect(text).not.toContain('params');
  });

  it('caps the text at 1000 characters', () => {
    expect(lastErrorText(new Error('x'.repeat(5_000)))).toHaveLength(1_000);
  });

  it('stops at the last Error when a cause is not one', () => {
    expect(lastErrorText(new TypeError('handler failed', { cause: { code: 'E1' } }))).toBe('TypeError: handler failed');
    expect(lastErrorText('a thrown string')).toBe('Error: a thrown string');
  });
});

describe('rootCause', () => {
  it('drops the query wrapper and hands back the driver error, stack and all', () => {
    const wrapped = queryError('57P01', 'terminating connection due to administrator command');

    const root = rootCause(wrapped);

    expect(root).toBe(wrapped.cause);
    expect(`${root.message}\n${root.stack}`).not.toContain('buyer@x.test');
  });

  it('hands back an error without a cause as it is', () => {
    const failure = new Error('user-service unavailable');

    expect(rootCause(failure)).toBe(failure);
  });
});

describe('isDataException', () => {
  it('spots SQLSTATE class 22 anywhere along the cause chain', () => {
    expect(isDataException(queryError('22P05', 'unsupported Unicode escape sequence'))).toBe(true);
    expect(isDataException(Object.assign(new Error('bad utf8'), { code: '22021' }))).toBe(true);
  });

  it('refuses every other failure', () => {
    expect(isDataException(queryError('23505', 'duplicate key value'))).toBe(false);
    expect(isDataException(queryError('57P01', 'terminating connection'))).toBe(false);
    expect(isDataException(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(false);
    expect(isDataException(undefined)).toBe(false);
  });
});
