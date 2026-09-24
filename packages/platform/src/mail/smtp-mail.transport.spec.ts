import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { SmtpMailTransport } from './smtp-mail.transport';

function build({ breakerRejects = false }: { breakerRejects?: boolean } = {}) {
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
  const run = breakerRejects
    ? vi.fn().mockRejectedValue(new Error('mail breaker open'))
    : vi.fn((task: () => Promise<unknown>) => task());
  const info = vi.fn();
  const transport = new SmtpMailTransport({
    url: 'smtp://mail.test:1025',
    from: 'shop@test.local',
    breaker: { run },
    timeoutMs: 10_000,
    transporter: { sendMail },
    logger: fakePinoLogger({ info }),
  });
  return { transport, sendMail, info };
}

describe('SmtpMailTransport', () => {
  it('logs a sent message by subject and messageId, never the to-address', async () => {
    const { transport, info } = build();

    await transport.sendMail({ to: 'buyer@test.local', subject: 'Hi', text: 'body' });

    expect(info.mock.calls[0][0]).toEqual({ subject: 'Hi', messageId: 'x' });
    expect(JSON.stringify(info.mock.calls[0])).not.toContain('buyer@test.local');
  });

  it('surfaces a refused call rather than reporting a message that never left', async () => {
    const { transport, sendMail, info } = build({ breakerRejects: true });

    await expect(transport.sendMail({ to: 'buyer@test.local', subject: 'Hi', text: 'body' })).rejects.toThrow(
      'mail breaker open',
    );
    expect(sendMail).not.toHaveBeenCalled();
    // Not logged here: every caller already catches and logs its own mail failures.
    expect(info).not.toHaveBeenCalled();
  });
});
