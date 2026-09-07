import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { CircuitBreakerFactory } from '@shared/resilience';
import { LogMailTransport } from './log-mail.transport';
import { createMailTransport } from './mail.module';
import { MAIL_BREAKER, SmtpMailTransport } from './smtp-mail.transport';

function build(values: Record<string, unknown>) {
  const create = vi.fn().mockReturnValue({ run: vi.fn() });
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  return { config, breakers: { create } as unknown as CircuitBreakerFactory, create };
}

describe('createMailTransport', () => {
  it('falls back to the log sink outside production', () => {
    const { config, breakers } = build({ 'app.env': 'development' });
    expect(createMailTransport(config, breakers)).toBeInstanceOf(LogMailTransport);
  });

  // The sink delivers nothing, so booting on it in production would leave every verification and
  // reset link unsent while the app reported itself healthy.
  it('refuses to boot in production without an SMTP URL', () => {
    const { config, breakers } = build({ 'app.env': 'production' });
    expect(() => createMailTransport(config, breakers)).toThrow(/SMTP_URL is required in production/);
  });

  it('refuses an SMTP URL with no sender, which most relays reject anyway', () => {
    const { config, breakers } = build({ 'app.env': 'development', 'mail.smtpUrl': 'smtp://mail.test:1025' });
    expect(() => createMailTransport(config, breakers)).toThrow(/MAIL_FROM is required/);
  });

  it('gives SMTP its own breaker and timeout, so a slow relay cannot open the checkout circuit', () => {
    const { config, breakers, create } = build({
      'app.env': 'production',
      'mail.smtpUrl': 'smtp://mail.test:1025',
      'mail.from': 'shop@test.local',
      'mail.timeoutMs': 7000,
    });

    expect(createMailTransport(config, breakers)).toBeInstanceOf(SmtpMailTransport);
    expect(create).toHaveBeenCalledWith(MAIL_BREAKER, { timeoutMs: 7000 });
  });
});
