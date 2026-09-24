import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('trims and lowercases, and is idempotent', () => {
    const once = normalizeEmail('  Alice@Example.COM \n');

    expect(once).toBe('alice@example.com');
    expect(normalizeEmail(once)).toBe(once);
  });

  // Provider dot and plus folding is out of scope: these are distinct rows to `UNIQUE(users.email)`.
  it('keeps provider dots and plus tags', () => {
    expect(normalizeEmail('a.l.i.c.e+tag@example.com')).toBe('a.l.i.c.e+tag@example.com');
  });
});
