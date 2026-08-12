import { createHash } from 'node:crypto';
import { hashRefreshToken } from './hash-refresh-token';

describe('hashRefreshToken', () => {
  it('produces a 64-char lowercase hex SHA-256 digest', () => {
    const hash = hashRefreshToken('some-opaque-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic (same input -> same hash) so lookups match', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
  });

  it('differs for different inputs', () => {
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });

  it('matches a plain sha256(hex) of the input (issue side == verify side)', () => {
    const raw = 'the-raw-refresh-token';
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(hashRefreshToken(raw)).toBe(expected);
  });

  it('never returns the raw token', () => {
    const raw = 'the-raw-refresh-token';
    expect(hashRefreshToken(raw)).not.toBe(raw);
  });
});
