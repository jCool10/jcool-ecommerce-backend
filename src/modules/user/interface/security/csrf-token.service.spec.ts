import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { CsrfTokenService } from './csrf-token.service';

function serviceWithSecret(secret: string): CsrfTokenService {
  const config = { getOrThrow: () => secret } as unknown as ConfigService;
  return new CsrfTokenService(config);
}

const SECRET = 'test-jwt-access-secret-not-a-real-secret-000';

describe('CsrfTokenService', () => {
  const csrf = serviceWithSecret(SECRET);

  it('issues tokens in random.signature form and never repeats', () => {
    const a = csrf.issue();
    const b = csrf.issue();

    expect(a).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(a).not.toBe(b);
  });

  it('accepts a token echoed back identically in cookie + header', () => {
    const token = csrf.issue();
    expect(csrf.verify(token, token)).toBe(true);
  });

  it('rejects when cookie and header differ (the double-submit check)', () => {
    expect(csrf.verify(csrf.issue(), csrf.issue())).toBe(false);
  });

  it('rejects when either side is missing', () => {
    const token = csrf.issue();
    expect(csrf.verify(undefined, token)).toBe(false);
    expect(csrf.verify(token, undefined)).toBe(false);
    expect(csrf.verify(undefined, undefined)).toBe(false);
  });

  it('rejects a token whose signature was tampered with', () => {
    const [random] = csrf.issue().split('.');
    const forged = `${random}.not-the-real-signature`;
    expect(csrf.verify(forged, forged)).toBe(false);
  });

  it('rejects a well-formed token minted under a different secret (cookie injection)', () => {
    const attacker = serviceWithSecret('a-completely-different-secret-value-000000');
    const foreign = attacker.issue();
    expect(csrf.verify(foreign, foreign)).toBe(false);
  });

  it('rejects a value with no signature separator', () => {
    expect(csrf.verify('no-dot-here', 'no-dot-here')).toBe(false);
  });
});
