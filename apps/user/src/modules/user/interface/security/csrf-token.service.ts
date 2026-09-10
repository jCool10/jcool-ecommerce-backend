import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Signed double-submit tokens (`random.hmac(random)`): the same value sits in a readable cookie and
 * must be echoed in a header, and a valid signature is required as well — so an attacker who can set
 * a cookie still cannot forge one. The HMAC key is derived from the token-signing private key —
 * the one secret only the issuer holds, and the same one whose rotation already invalidates every
 * outstanding access token, so a rotation strands no CSRF cookie a live session still needs.
 */
@Injectable()
export class CsrfTokenService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const signingKey = config.getOrThrow<string>('auth.jwtPrivateKey');
    this.key = createHmac('sha256', signingKey).update('csrf-double-submit-v1').digest();
  }

  issue(): string {
    const random = randomBytes(32).toString('base64url');
    return `${random}.${this.sign(random)}`;
  }

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
