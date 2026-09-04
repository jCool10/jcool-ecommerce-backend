import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alice@Example.COM \n')).toBe('alice@example.com');
  });

  it('leaves an already-canonical address untouched', () => {
    expect(normalizeEmail('alice@example.com')).toBe('alice@example.com');
  });

  it('does not fold provider dots or plus tags — those are distinct accounts to `UNIQUE(email)`', () => {
    expect(normalizeEmail('a.l.i.c.e+tag@example.com')).toBe('a.l.i.c.e+tag@example.com');
  });

  it('is idempotent, so routing and uniqueness cannot drift by re-normalizing', () => {
    const once = normalizeEmail(' Bob@Example.com ');
    expect(normalizeEmail(once)).toBe(once);
  });
});
