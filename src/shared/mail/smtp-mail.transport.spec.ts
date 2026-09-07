import { describe, expect, it, vi } from 'vitest';
import { SmtpMailTransport } from './smtp-mail.transport';

function build({ breakerRejects = false }: { breakerRejects?: boolean } = {}) {
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
  const run = breakerRejects
    ? vi.fn().mockRejectedValue(new Error('mail breaker open'))
    : vi.fn((task: () => Promise<unknown>) => task());
  const transport = new SmtpMailTransport({
    url: 'smtp://mail.test:1025',
    from: 'shop@test.local',
    breaker: { run },
    transporter: { sendMail },
  });
  return { transport, sendMail, run };
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

  it('surfaces a refused call rather than reporting a message that never left', async () => {
    const { transport, sendMail } = build({ breakerRejects: true });

    await expect(transport.sendMail({ to: 'buyer@test.local', subject: 'Hi', text: 'body' })).rejects.toThrow(
      'mail breaker open',
    );
    expect(sendMail).not.toHaveBeenCalled();
  });
});
