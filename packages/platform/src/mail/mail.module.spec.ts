import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { describe, expect, it, vi } from 'vitest';
import type { CircuitBreakerFactory } from '../resilience';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { createMailTransport } from './mail.module';
import { MAIL_BREAKER, SmtpMailTransport } from './smtp-mail.transport';

function build(values: Record<string, unknown>) {
  const create = vi.fn().mockReturnValue({ run: vi.fn() });
  const config = fakeConfigService(values);
  return { config, breakers: { create } as unknown as CircuitBreakerFactory, create, logger: fakePinoLogger() };
}

describe('createMailTransport', () => {
  it('refuses to boot in production without an SMTP URL', () => {
    const { config, breakers, logger } = build({ 'app.env': 'production' });
    expect(() => createMailTransport(config, breakers, logger)).toThrow(/SMTP_URL is required in production/);
  });

  it('refuses an SMTP URL with no MAIL_FROM', () => {
    const { config, breakers, logger } = build({ 'app.env': 'development', 'mail.smtpUrl': 'smtp://mail.test:1025' });
    expect(() => createMailTransport(config, breakers, logger)).toThrow(/MAIL_FROM is required/);
  });

  // The loopback default is what `.env.example` ships, so this is the copied-dev-file case.
  it('refuses to boot in production against a loopback relay', () => {
    const { config, breakers, logger } = build({
      'app.env': 'production',
      'mail.smtpUrl': 'smtp://localhost:1025',
      'mail.from': 'shop@test.local',
      'mail.timeoutMs': 10_000,
    });
    expect(() => createMailTransport(config, breakers, logger)).toThrow(/loopback relay in production/);
  });

  // A breaker shared with the payment gateway would let a slow relay open the checkout circuit.
  it('builds SMTP in production on its own breaker and timeout', () => {
    const { config, breakers, create, logger } = build({
      'app.env': 'production',
      'mail.smtpUrl': 'smtp://mail.test:1025',
      'mail.from': 'shop@test.local',
      'mail.timeoutMs': 7000,
    });

    expect(createMailTransport(config, breakers, logger)).toBeInstanceOf(SmtpMailTransport);
    expect(create).toHaveBeenCalledWith(MAIL_BREAKER, { timeoutMs: 7000 });
  });
});
