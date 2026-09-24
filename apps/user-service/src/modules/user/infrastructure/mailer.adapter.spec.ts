import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '@jcool/platform/mail';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
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
  return { mailer, recordMailSendFailure, error, sent: () => sendMail.mock.calls.map(([m]) => m as MailMessage) };
}

describe('MailerAdapter', () => {
  it('links each mail to its page on the public URL, URL-encoding the raw token', async () => {
    const { mailer, sent } = build();

    await mailer.sendEmailVerification({ to: 'user@test.local', token: TOKEN });
    await mailer.sendPasswordReset({ to: 'user@test.local', token: TOKEN });

    expect(sent()).toEqual([
      expect.objectContaining({
        to: 'user@test.local',
        text: expect.stringContaining('https://app.example.com/auth/verify-email?token=tok%20en%2F%2Braw') as unknown,
      }),
      expect.objectContaining({
        to: 'user@test.local',
        text: expect.stringContaining('https://app.example.com/auth/reset-password?token=tok%20en%2F%2Braw') as unknown,
      }),
    ]);
  });

  // The enumeration-safe routes answer 202 either way, so a send that threw would reveal the account.
  it('counts and swallows a failed send without logging the token', async () => {
    const { mailer, recordMailSendFailure, error } = build({ fails: true });

    await expect(mailer.sendPasswordReset({ to: 'user@test.local', token: TOKEN })).resolves.toBeUndefined();

    expect(recordMailSendFailure).toHaveBeenCalledExactlyOnceWith('password_reset');
    expect(error).toHaveBeenCalledExactlyOnceWith(
      { kind: 'password_reset', err: expect.any(Error) as unknown },
      expect.any(String),
    );
    // Over the whole call, not just the fields: the body holds a redeemable token, and an `err`
    // message or stack that quoted it would leak it just as far.
    expect(inspect(error.mock.calls[0], { depth: null })).not.toContain(TOKEN);
  });
});
