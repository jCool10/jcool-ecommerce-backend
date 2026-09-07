import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogMailTransport } from './log-mail.transport';

describe('LogMailTransport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records the envelope and the body length, never the body', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const token = 'redeemable-raw-token';

    await new LogMailTransport().sendMail({
      to: 'user@test.local',
      subject: 'Verify your email address',
      text: `https://app.test/auth/verify-email?token=${token}`,
    });

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    // The whole point of this sink: a forgotten SMTP_URL must not spill redeemable links into logs.
    expect(line).not.toContain(token);
    const payload = JSON.parse(line) as { to: string; subject: string; bodyChars: number };
    expect(payload).toMatchObject({ to: 'user@test.local', subject: 'Verify your email address' });
    expect(payload.bodyChars).toBeGreaterThan(0);
  });
});
