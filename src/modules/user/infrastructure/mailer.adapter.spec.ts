import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@shared/mail/mail-transport.port';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { MailerAdapter } from './mailer.adapter';

const TOKEN = 'tok en/+raw';

function build({ fails = false }: { fails?: boolean } = {}) {
  const sendMail = fails ? vi.fn().mockRejectedValue(new Error('smtp down')) : vi.fn().mockResolvedValue(undefined);
  const recordMailSendFailure = vi.fn();
  const config = { get: () => 'https://app.example.com' } as unknown as ConfigService;
  const mailer = new MailerAdapter({ sendMail }, { recordMailSendFailure } as unknown as MetricsPort, config);
  return { mailer, sendMail, recordMailSendFailure, sent: () => sendMail.mock.calls[0][0] as MailMessage };
}

describe('MailerAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds a verification link on the public URL, URL-encoding the raw token', async () => {
    const { mailer, sent } = build();

    await mailer.sendEmailVerification({ to: 'user@test.local', token: TOKEN });

    expect(sent().to).toBe('user@test.local');
    expect(sent().text).toContain('https://app.example.com/auth/verify-email?token=tok%20en%2F%2Braw');
  });

  it('builds a reset link the same way', async () => {
    const { mailer, sent } = build();

    await mailer.sendPasswordReset({ to: 'user@test.local', token: TOKEN });

    expect(sent().text).toContain('https://app.example.com/auth/reset-password?token=tok%20en%2F%2Braw');
  });

  it('counts a failed send and swallows it, so a dead mail server is not an enumeration oracle', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { mailer, recordMailSendFailure } = build({ fails: true });

    await expect(mailer.sendPasswordReset({ to: 'user@test.local', token: TOKEN })).resolves.toBeUndefined();

    expect(recordMailSendFailure).toHaveBeenCalledWith('password_reset');
    expect(error.mock.calls[0][0]).not.toContain(TOKEN);
  });
});
