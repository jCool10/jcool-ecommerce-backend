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
  return { transport, sendMail, run, info };
}

describe('SmtpMailTransport', () => {
  it('sends through the breaker with the configured sender', async () => {
    const { transport, sendMail, run } = build();

    await transport.sendMail({ to: 'buyer@test.local', subject: 'Hi', text: 'body' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'shop@test.local',
      to: 'buyer@test.local',
      subject: 'Hi',
      text: 'body',
    });
  });

  it('logs the send, by subject and messageId — never the to-address', async () => {
    const { transport, info } = build();

    await transport.sendMail({ to: 'buyer@test.local', subject: 'Hi', text: 'body' });

    expect(info).toHaveBeenCalledWith({ subject: 'Hi', messageId: 'x' }, 'mail sent');
    expect(JSON.stringify(info.mock.calls[0])).not.toContain('buyer@test.local');
  });

  it('surfaces a refused call rather than reporting a message that never left', async () => {
    const { transport, sendMail, info } = build({ breakerRejects: true });

    await expect(transport.sendMail({ to: 'buyer@test.local', subject: 'Hi', text: 'body' })).rejects.toThrow(
      'mail breaker open',
    );
    expect(sendMail).not.toHaveBeenCalled();
    // The failure is not logged here — every caller already catches and logs its own mail failures.
    expect(info).not.toHaveBeenCalled();
  });
});
