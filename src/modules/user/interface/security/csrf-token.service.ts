import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Signed double-submit CSRF tokens. A token is `random.hmac(random)`; the same
 * value is set in a readable cookie AND must be echoed in a request header. The
 * guard requires cookie === header (so a cross-site caller, unable to read the
 * cookie under the same-origin policy, can't forge the header) and a valid
 * signature (so an attacker who can *write* a cookie — subdomain/MITM — still
 * can't mint one without the key). SameSite=Strict on the refresh cookie is the
 * primary defence; this is the belt-and-suspenders layer.
 *
 * The signing key is derived from JWT_ACCESS_SECRET via a labelled HMAC, so it's
 * cryptographically separate from the JWT key without introducing a new env var.
 */
@Injectable()
export class CsrfTokenService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const appSecret = config.getOrThrow<string>('auth.jwtAccessSecret');
    this.key = createHmac('sha256', appSecret).update('csrf-double-submit-v1').digest();
  }

  /** Mint a fresh signed token to set in the CSRF cookie on login/refresh. */
  issue(): string {
    const random = randomBytes(32).toString('base64url');
    return `${random}.${this.sign(random)}`;
  }

  /**
   * Valid when both values are present, identical (double-submit), and the
   * presented token carries an authentic signature. Constant-time throughout.
   */
  verify(cookieValue: string | undefined, headerValue: string | undefined): boolean {
    if (!cookieValue || !headerValue) return false;
    if (!this.constantTimeEquals(cookieValue, headerValue)) return false;

    const separator = cookieValue.lastIndexOf('.');
    if (separator <= 0) return false;
    const random = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    return this.constantTimeEquals(signature, this.sign(random));
  }

  private sign(random: string): string {
    return createHmac('sha256', this.key).update(random).digest('base64url');
  }

  // timingSafeEqual throws on unequal lengths, so gate on length first. The
  // length check is not itself constant-time, but token length is not a secret.
  private constantTimeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
  }
}
