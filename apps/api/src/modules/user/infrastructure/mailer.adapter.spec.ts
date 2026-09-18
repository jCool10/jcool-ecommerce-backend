import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@shared/mail/mail-transport.port';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { fakeMetricsPort } from '@shared/testing/fake-metrics-port';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import { MailerAdapter } from './mailer.adapter';

const TOKEN = 'tok en/+raw';

function build({ fails = false }: { fails?: boolean } = {}) {
  const sendMail = fails ? vi.fn().mockRejectedValue(new Error('smtp down')) : vi.fn().mockResolvedValue(undefined);
  const recordMailSendFailure = vi.fn();
  const error = vi.fn();
  const config = fakeConfigService({ 'app.publicUrl': 'https://app.example.com' });
  const mailer = new MailerAdapter(
    { sendMail },
    fakeMetricsPort({ recordMailSendFailure }),
    config,
    fakePinoLogger({ error }),
  );
  return { mailer, sendMail, recordMailSendFailure, error, sent: () => sendMail.mock.calls[0][0] as MailMessage };
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
    const { mailer, recordMailSendFailure, error } = build({ fails: true });

    await expect(mailer.sendPasswordReset({ to: 'user@test.local', token: TOKEN })).resolves.toBeUndefined();

    expect(recordMailSendFailure).toHaveBeenCalledWith('password_reset');
    expect(error).toHaveBeenCalledWith(
      { kind: 'password_reset', err: expect.any(Error) as unknown },
      'mail send failed',
    );
    // Over the whole call, not just the fields: the body holds a redeemable token, and an `err`
    // message or stack that quoted it would leak it just as far.
    expect(inspect(error.mock.calls[0], { depth: null })).not.toContain(TOKEN);
  });
});
