import { describe, expect, it } from 'vitest';
import { isCheckViolation, isUniqueViolation } from './pg-errors';

const wrapped = (error: unknown, levels: number): unknown => {
  let current = error;
  for (let level = 0; level < levels; level++) current = { message: 'Failed query', cause: current };
  return current;
};

const unique = (constraint?: string) => ({ code: '23505', ...(constraint === undefined ? {} : { constraint }) });

describe('isUniqueViolation', () => {
  it('recognises a unique violation thrown as is', () => {
    expect(isUniqueViolation(unique('users_email_key'))).toBe(true);
  });

  // Drizzle wraps the driver error, so the SQLSTATE sits on a `cause`.
  it.each([1, 2, 4])('finds one %i cause level(s) down', (levels) => {
    expect(isUniqueViolation(wrapped(unique('users_email_key'), levels))).toBe(true);
  });

  it('stops walking the cause chain after five links', () => {
    expect(isUniqueViolation(wrapped(unique('users_email_key'), 5))).toBe(false);
  });

  it('matches the index it is asked about and no other', () => {
    expect(isUniqueViolation(wrapped(unique('users_email_key'), 1), 'users_email_key')).toBe(true);
    expect(isUniqueViolation(wrapped(unique('orders_pkey'), 1), 'users_email_key')).toBe(false);
  });

  it('counts a violation whose driver left the constraint unset', () => {
    expect(isUniqueViolation(unique(), 'users_email_key')).toBe(true);
  });

  it('ignores another SQLSTATE', () => {
    expect(isUniqueViolation({ code: '23503', constraint: 'users_email_key' })).toBe(false);
  });

  it.each([
    ['a string', 'duplicate key'],
    ['null', null],
  ])('ends the walk at %s', (_case, link) => {
    expect(isUniqueViolation(link)).toBe(false);
    expect(isUniqueViolation({ message: 'Failed query', cause: link })).toBe(false);
  });
});

describe('isCheckViolation', () => {
  const check = (constraint: string) => ({ code: '23514', constraint });

  it('matches the named check constraint, directly or one cause down', () => {
    expect(isCheckViolation(check('stock_non_negative'), 'stock_non_negative')).toBe(true);
    expect(isCheckViolation(wrapped(check('stock_non_negative'), 1), 'stock_non_negative')).toBe(true);
  });

  it('ignores another check constraint', () => {
    expect(isCheckViolation(check('price_positive'), 'stock_non_negative')).toBe(false);
  });

  it('answers false for a non-object', () => {
    expect(isCheckViolation('check violation', 'stock_non_negative')).toBe(false);
  });
});
