import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { describe, expect, it } from 'vitest';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from './throttler.constants';

class AuthController {
  login(this: void): void {}
}

const guard = new AccountAwareThrottlerGuard(
  { throttlers: [] },
  {} as ThrottlerStorage,
  {} as Reflector,
  fakeMetricsPort(),
  fakePinoLogger(),
);

function keyFor(body: unknown, ip: string, tier: string): string {
  const context = new ExecutionContextHost([{ body }], AuthController, AuthController.prototype.login);
  // generateKey is protected.
  const shim = guard as unknown as { generateKey(c: ExecutionContext, suffix: string, name: string): string };
  return shim.generateKey(context, ip, tier);
}

describe('AccountAwareThrottlerGuard.generateKey', () => {
  const ip = '1.2.3.4';

  it('keys the default tier by IP only, ignoring the email', () => {
    expect(keyFor({ email: 'a@b.com' }, ip, DEFAULT_THROTTLER)).toBe(
      keyFor({ email: 'x@y.com' }, ip, DEFAULT_THROTTLER),
    );
  });

  it('puts case and spacing variants of one account email in one bucket', () => {
    expect(keyFor({ email: 'User@B.com' }, ip, ACCOUNT_THROTTLER)).toBe(
      keyFor({ email: '  user@b.com ' }, ip, ACCOUNT_THROTTLER),
    );
  });

  it('separates the same account across different IPs', () => {
    expect(keyFor({ email: 'a@b.com' }, '1.1.1.1', ACCOUNT_THROTTLER)).not.toBe(
      keyFor({ email: 'a@b.com' }, '2.2.2.2', ACCOUNT_THROTTLER),
    );
  });

  it('falls back to the IP-only account bucket without a valid email', () => {
    const ipOnly = keyFor({}, ip, ACCOUNT_THROTTLER);

    expect([{ email: 123 }, { email: '   ' }, null].map((body) => keyFor(body, ip, ACCOUNT_THROTTLER))).toEqual([
      ipOnly,
      ipOnly,
      ipOnly,
    ]);
    expect(keyFor({ email: 'a@b.com' }, ip, ACCOUNT_THROTTLER)).not.toBe(ipOnly);
  });
});
