import type { ExecutionContext } from '@nestjs/common';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from './throttler.constants';

// generateKey is the overridden extension point and uses only the context/body,
// so construct the guard with placeholder framework deps and exercise it directly.
function makeGuard(): AccountAwareThrottlerGuard {
  return new AccountAwareThrottlerGuard({ throttlers: [] }, {} as never, {} as never);
}

// Minimal ExecutionContext: generateKey reads class/handler names and, for the
// account tier, the request body.
function contextFor(body: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ body }) }),
    getClass: () => ({ name: 'AuthController' }),
    getHandler: () => ({ name: 'login' }),
  } as unknown as ExecutionContext;
}

// generateKey is protected; reach it through a typed shim rather than casting inline.
function keyFor(guard: AccountAwareThrottlerGuard, body: unknown, ip: string, name: string): string {
  const shim = guard as unknown as { generateKey(c: ExecutionContext, s: string, n: string): string };
  return shim.generateKey(contextFor(body), ip, name);
}

describe('AccountAwareThrottlerGuard.generateKey', () => {
  const ip = '1.2.3.4';

  it('keys the default tier by IP only — the email is ignored', () => {
    const guard = makeGuard();

    const a = keyFor(guard, { email: 'a@b.com' }, ip, DEFAULT_THROTTLER);
    const b = keyFor(guard, { email: 'x@y.com' }, ip, DEFAULT_THROTTLER);

    expect(a).toBe(b);
  });

  it('keys the account tier per (IP, account): different emails on one IP are different buckets', () => {
    const guard = makeGuard();

    const a = keyFor(guard, { email: 'a@b.com' }, ip, ACCOUNT_THROTTLER);
    const b = keyFor(guard, { email: 'x@y.com' }, ip, ACCOUNT_THROTTLER);

    expect(a).not.toBe(b);
  });

  it('normalises the account email (case/space-insensitive) into one bucket', () => {
    const guard = makeGuard();

    const a = keyFor(guard, { email: 'User@B.com' }, ip, ACCOUNT_THROTTLER);
    const b = keyFor(guard, { email: '  user@b.com ' }, ip, ACCOUNT_THROTTLER);

    expect(a).toBe(b);
  });

  it('separates the same account across different IPs', () => {
    const guard = makeGuard();

    const a = keyFor(guard, { email: 'a@b.com' }, '1.1.1.1', ACCOUNT_THROTTLER);
    const b = keyFor(guard, { email: 'a@b.com' }, '2.2.2.2', ACCOUNT_THROTTLER);

    expect(a).not.toBe(b);
  });

  it('falls back to the IP-only bucket for the account tier when no valid email is present', () => {
    const guard = makeGuard();

    const noEmail = keyFor(guard, {}, ip, ACCOUNT_THROTTLER);
    const badType = keyFor(guard, { email: 123 }, ip, ACCOUNT_THROTTLER);
    const blank = keyFor(guard, { email: '   ' }, ip, ACCOUNT_THROTTLER);
    const withEmail = keyFor(guard, { email: 'a@b.com' }, ip, ACCOUNT_THROTTLER);

    // Every no-email variant collapses to the same IP-only bucket...
    expect(badType).toBe(noEmail);
    expect(blank).toBe(noEmail);
    // ...while a real email is a distinct (IP, account) bucket.
    expect(withEmail).not.toBe(noEmail);
  });
});
