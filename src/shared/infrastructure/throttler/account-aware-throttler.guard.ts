import { createHash } from 'node:crypto';
import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { ACCOUNT_THROTTLER } from './throttler.constants';

/**
 * ThrottlerGuard that gives the `account` tier an account dimension: its key is
 * the client IP (the base tracker) plus a hashed email, so a brute-force run
 * against one account is capped on its own bucket and cannot lock out other
 * users sharing the same IP (NAT). Every other tier stays keyed by IP alone —
 * which is what catches password-spray (many accounts, one IP).
 *
 * The tier name is only available in `generateKey` (v6 calls `getTracker` once
 * per request, before the tier is known), so the account dimension is folded in
 * here by extending the IP suffix. Email is hashed so no plaintext identifier is
 * written into Redis keys.
 */
@Injectable()
export class AccountAwareThrottlerGuard extends ThrottlerGuard {
  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    if (name === ACCOUNT_THROTTLER) {
      const request = context.switchToHttp().getRequest<Request>();
      return super.generateKey(context, this.accountSuffix(suffix, request.body), name);
    }
    return super.generateKey(context, suffix, name);
  }

  // Fold a hashed account id into the IP suffix so the account tier buckets per
  // (IP, account); falls back to the IP suffix alone when no email is present.
  private accountSuffix(ipSuffix: string, body: unknown): string {
    const email = this.extractEmail(body);
    if (!email) {
      return ipSuffix;
    }
    const hashed = createHash('sha256').update(email).digest('hex').slice(0, 16);
    return `${ipSuffix}:${hashed}`;
  }

  // Guards run after express body-parsing but before validation, so the body is
  // present yet untrusted: accept only a non-empty string email and normalise it
  // the same way logins compare (trim + lowercase) so both key to one bucket.
  private extractEmail(body: unknown): string | undefined {
    if (typeof body === 'object' && body !== null && 'email' in body) {
      const { email } = body;
      if (typeof email === 'string' && email.trim().length > 0) {
        return email.trim().toLowerCase();
      }
    }
    return undefined;
  }
}
