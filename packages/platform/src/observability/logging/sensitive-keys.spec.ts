import { describe, expect, it } from 'vitest';
import { isSensitiveKey } from './sensitive-keys';

describe('isSensitiveKey', () => {
  // verifyUrl and resetUrl carry a redeemable token under a key that is not named token.
  it('matches credentials and mail links case-insensitively', () => {
    const keys = ['password', 'Authorization', 'REFRESHTOKEN', 'Set-Cookie', 'verifyUrl', 'resetUrl'];

    expect(keys.filter((key) => !isSensitiveKey(key))).toEqual([]);
  });

  // The auth audit trail records email in logs; the Sentry sink strips it separately.
  it('leaves email and identifiers alone', () => {
    expect(['email', 'orderId', 'name'].filter(isSensitiveKey)).toEqual([]);
  });
});
