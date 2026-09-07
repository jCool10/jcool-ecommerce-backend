import { describe, expect, it } from 'vitest';
import { SENSITIVE_KEYS, isSensitiveKey } from './sensitive-keys';

describe('isSensitiveKey', () => {
  it('matches the canonical keys case-insensitively', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('REFRESHTOKEN')).toBe(true);
    expect(isSensitiveKey('Set-Cookie')).toBe(true);
  });

  it('covers the mail links, which carry a redeemable token under a key that is not named token', () => {
    expect(isSensitiveKey('verifyUrl')).toBe(true);
    expect(isSensitiveKey('resetUrl')).toBe(true);
  });

  it('leaves non-sensitive keys alone', () => {
    expect(isSensitiveKey('email')).toBe(false);
    expect(isSensitiveKey('orderId')).toBe(false);
    expect(isSensitiveKey('name')).toBe(false);
  });

  it('keeps email out of the shared list (audit logs deliberately retain it — ADR-0013)', () => {
    expect(SENSITIVE_KEYS).not.toContain('email');
  });
});
