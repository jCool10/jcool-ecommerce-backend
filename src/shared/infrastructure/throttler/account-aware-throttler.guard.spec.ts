import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER, USER_THROTTLER } from './throttler.constants';

// generateKey is the overridden extension point and uses only the context/body,
// so construct the guard with placeholder framework deps and exercise it directly.
function makeGuard(storage: ThrottlerStorage = {} as never): AccountAwareThrottlerGuard {
  return new AccountAwareThrottlerGuard({ throttlers: [] }, storage, {} as never, {} as never);
}

// Minimal ExecutionContext: generateKey reads class/handler names and, for the
// account tier, the request body; a tier that is actually enforced also writes
// the rate-limit response headers.
function contextFor(body: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body, ip: '1.2.3.4', path: '/auth/login' }),
      getResponse: () => ({ header: vi.fn() }),
    }),
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

describe('AccountAwareThrottlerGuard tiers', () => {
  async function handleFor(tier: string, increment: ThrottlerStorage['increment']): Promise<boolean> {
    const guard = makeGuard({ increment });
    await guard.onModuleInit(); // resolves the options the base guard reads per request
    const shim = guard as unknown as { handleRequest(request: ThrottlerRequest): Promise<boolean> };
    return shim.handleRequest({
      context: contextFor({}),
      limit: 10,
      ttl: 60_000,
      blockDuration: 60_000,
      throttler: { name: tier, limit: 10, ttl: 60_000 },
      getTracker: () => Promise.resolve('1.2.3.4'),
      generateKey: () => 'key',
    });
  }

  // This guard is global, so it runs before authentication — it has no id to key the user tier by,
  // and counting it here on the IP would silently give the tier the wrong meaning.
  it('leaves the user tier alone', async () => {
    const increment = vi.fn<ThrottlerStorage['increment']>();

    await expect(handleFor(USER_THROTTLER, increment)).resolves.toBe(true);

    expect(increment).not.toHaveBeenCalled();
  });

  it('still enforces the IP tier it owns', async () => {
    const increment = vi.fn<ThrottlerStorage['increment']>().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });

    await expect(handleFor(DEFAULT_THROTTLER, increment)).resolves.toBe(true);

    expect(increment).toHaveBeenCalledTimes(1);
  });
});
