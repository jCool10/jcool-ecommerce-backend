import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogMailer } from './log-mailer';

// Config stub returning a fixed public base URL for link building.
function makeConfig(publicUrl: string): ConfigService {
  return { get: () => publicUrl } as unknown as ConfigService;
}

describe('LogMailer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits a structured verification line with a link carrying the token', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mailer = new LogMailer(makeConfig('https://app.example.com'));

    await mailer.sendEmailVerification({ to: 'user@test.local', token: 'tok en/+raw' });

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0][0] as string) as {
      mail: string;
      to: string;
      verifyUrl: string;
      ts: string;
    };
    expect(payload.mail).toBe('email_verification');
    expect(payload.to).toBe('user@test.local');
    // The raw token rides the link URL-encoded so it survives special characters.
    expect(payload.verifyUrl).toBe('https://app.example.com/auth/verify-email?token=tok%20en%2F%2Braw');
    expect(Number.isNaN(Date.parse(payload.ts))).toBe(false);
  });

  it('emits a structured password-reset line with a link carrying the token', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mailer = new LogMailer(makeConfig('https://app.example.com'));

    await mailer.sendPasswordReset({ to: 'user@test.local', token: 'tok en/+raw' });

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0][0] as string) as {
      mail: string;
      to: string;
      resetUrl: string;
      ts: string;
    };
    expect(payload.mail).toBe('password_reset');
    expect(payload.to).toBe('user@test.local');
    expect(payload.resetUrl).toBe('https://app.example.com/auth/reset-password?token=tok%20en%2F%2Braw');
    expect(Number.isNaN(Date.parse(payload.ts))).toBe(false);
  });
});
