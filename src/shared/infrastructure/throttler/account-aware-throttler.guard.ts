import { createHash } from 'node:crypto';
import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { ACCOUNT_THROTTLER } from './throttler.constants';

/**
 * ThrottlerGuard that keys the `account` tier by IP + hashed email, so brute-forcing one account
 * can't lock out others behind the same NAT (other tiers stay IP-only, which catches password-spray).
 * See docs/engineering-notes.md (Auth — Rate limiting / brute-force protection).
 */
@Injectable()
export class AccountAwareThrottlerGuard extends ThrottlerGuard {
  // Global kill-switch (load tests / e2e). Enforced here, not via the module's `skipIf`
  // option, which this throttler version leaves unapplied so enforcement never turns off.
  override canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.THROTTLE_ENABLED === 'false') {
      return Promise.resolve(true);
    }
    return super.canActivate(context);
  }

  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    if (name === ACCOUNT_THROTTLER) {
      const request = context.switchToHttp().getRequest<Request>();
      return super.generateKey(context, this.accountSuffix(suffix, request.body), name);
    }
    return super.generateKey(context, suffix, name);
  }

  // Fold a hashed account id into the IP suffix → the account tier buckets per (IP, account).
  private accountSuffix(ipSuffix: string, body: unknown): string {
    const email = this.extractEmail(body);
    if (!email) {
      return ipSuffix;
    }
    const hashed = createHash('sha256').update(email).digest('hex').slice(0, 16);
    return `${ipSuffix}:${hashed}`;
  }

  // Body is parsed but not yet validated here; accept only a non-empty string email and
  // normalise it like login (trim + lowercase) so both key to the same bucket.
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
