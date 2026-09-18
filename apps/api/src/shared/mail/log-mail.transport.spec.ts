import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import { LogMailTransport } from './log-mail.transport';

describe('LogMailTransport', () => {
  it('records the envelope and the body length, never the body', async () => {
    const info = vi.fn();
    const token = 'redeemable-raw-token';

    await new LogMailTransport(fakePinoLogger({ info })).sendMail({
      to: 'user@test.local',
      subject: 'Verify your email address',
      text: `https://app.test/auth/verify-email?token=${token}`,
    });

    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] as [{ to: string; subject: string; bodyChars: number }, string];
    expect(message).toBe('mail sent');
    expect(fields).toMatchObject({ to: 'user@test.local', subject: 'Verify your email address' });
    expect(fields.bodyChars).toBeGreaterThan(0);
    // The whole point of this sink: a forgotten SMTP_URL must not spill redeemable links into logs.
    expect(JSON.stringify(info.mock.calls[0])).not.toContain(token);
  });
});
