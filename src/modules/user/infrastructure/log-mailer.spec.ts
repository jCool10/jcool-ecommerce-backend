import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { LogMailer } from './log-mailer';

// Config stub returning a fixed public base URL for link building, plus the env that decides
// whether the single-use token may ride the logged link.
function makeConfig(publicUrl: string, env = 'development'): ConfigService {
  const values: Record<string, string> = { 'app.publicUrl': publicUrl, 'app.env': env };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

// Logger.log is typed with `any` params, so name the shape the assertions actually rely on.
type LogSpy = MockInstance<(message: string) => void>;

function captureLine(): LogSpy {
  return vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
}

describe('LogMailer — development', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits a structured verification line with a link carrying the token', async () => {
    const log = captureLine();
    const mailer = new LogMailer(makeConfig('https://app.example.com'));

    await mailer.sendEmailVerification({ to: 'user@test.local', token: 'tok en/+raw' });

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0][0]) as {
      mail: string;
      to: string;
      verifyUrl: string;
      ts: string;
    };
    expect(payload.mail).toBe('email_verification');
    expect(payload.to).toBe('user@test.local');
    // The raw token rides the link URL-encoded so it survives special characters. Printing the
    // whole link is the point of this sink locally: it is how a developer finishes a signup
    // without SMTP.
    expect(payload.verifyUrl).toBe('https://app.example.com/auth/verify-email?token=tok%20en%2F%2Braw');
    expect(Number.isNaN(Date.parse(payload.ts))).toBe(false);
  });

  it('emits a structured password-reset line with a link carrying the token', async () => {
    const log = captureLine();
    const mailer = new LogMailer(makeConfig('https://app.example.com'));

    await mailer.sendPasswordReset({ to: 'user@test.local', token: 'tok en/+raw' });

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0][0]) as {
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

/**
 * This is the only MailerPort wired today, so a deploy with no SMTP adapter runs it — and a
 * verification or reset token in a log platform is a live account-takeover credential readable by
 * anyone with log access. Asserted over the whole serialized line, not one field: a token that
 * reappears under another key is still a leak.
 */
describe('LogMailer — outside development', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['sendEmailVerification', 'verifyUrl', 'https://app.example.com/auth/verify-email'],
    ['sendPasswordReset', 'resetUrl', 'https://app.example.com/auth/reset-password'],
  ] as const)('never logs the token from %s', async (method, field, expected) => {
    const log = captureLine();
    const mailer = new LogMailer(makeConfig('https://app.example.com', 'production'));

    await mailer[method]({ to: 'user@test.local', token: 'a-live-single-use-token' });

    const line = log.mock.calls[0][0];
    expect(line).not.toContain('a-live-single-use-token');
    expect(line).not.toContain('?token=');
    // The event is still recorded — who was mailed, and what kind of link was issued.
    const payload = JSON.parse(line) as Record<string, string>;
    expect(payload[field]).toBe(expected);
    expect(payload.to).toBe('user@test.local');
  });
});
