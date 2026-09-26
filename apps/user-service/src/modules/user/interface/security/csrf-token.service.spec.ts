import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { CsrfTokenService } from './csrf-token.service';

function serviceWithSecret(secret: string): CsrfTokenService {
  return new CsrfTokenService(fakeConfigService({ 'auth.csrfSecret': secret }));
}

const SECRET = 'test-jwt-access-secret-not-a-real-secret-000';

describe('CsrfTokenService', () => {
  const csrf = serviceWithSecret(SECRET);

  // Changing the derivation invalidates every CSRF cookie already in browsers, so each refresh
  // fails until its user logs in again.
  it('verifies a token signed under the pinned key derivation', () => {
    const key = createHmac('sha256', SECRET).update('csrf-double-submit-v1').digest();
    const token = `issued-earlier.${createHmac('sha256', key).update('issued-earlier').digest('base64url')}`;

    expect(csrf.verify(token, token)).toBe(true);
  });

  it('issues distinct random.signature tokens that verify when echoed back', () => {
    const a = csrf.issue();
    const b = csrf.issue();

    expect(a).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(a).not.toBe(b);
    expect(csrf.verify(a, a)).toBe(true);
  });

  it('rejects a cookie and header that differ', () => {
    expect(csrf.verify(csrf.issue(), csrf.issue())).toBe(false);
  });

  it('rejects when either side is missing', () => {
    const token = csrf.issue();

    expect([csrf.verify(undefined, token), csrf.verify(token, undefined), csrf.verify(undefined, undefined)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  // cookie-parser JSON-decodes a `j:`-prefixed cookie, so a forged one arrives as a non-string.
  it('rejects a non-string cookie value instead of throwing', () => {
    const token = csrf.issue();

    expect(csrf.verify({}, token)).toBe(false);
    expect(csrf.verify(['not-a-token'], token)).toBe(false);
    expect(csrf.verify(42, token)).toBe(false);
  });

  it('rejects a token whose signature was tampered with or left off', () => {
    const [random] = csrf.issue().split('.');
    const forged = `${random}.not-the-real-signature`;

    expect([csrf.verify(forged, forged), csrf.verify('no-dot-here', 'no-dot-here')]).toEqual([false, false]);
  });

  // An attacker able to plant a cookie can mint well-formed tokens, but only under their own secret.
  it('rejects a well-formed token minted under a different secret', () => {
    const foreign = serviceWithSecret('a-completely-different-secret-value-000000').issue();

    expect(csrf.verify(foreign, foreign)).toBe(false);
  });
});
