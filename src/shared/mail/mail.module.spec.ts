import { fakeConfigService } from '@shared/testing/fake-config.service';
import { describe, expect, it, vi } from 'vitest';
import type { CircuitBreakerFactory } from '@shared/resilience';
import { LogMailTransport } from './log-mail.transport';
import { createMailTransport } from './mail.module';
import { MAIL_BREAKER, SmtpMailTransport } from './smtp-mail.transport';

function build(values: Record<string, unknown>) {
  const create = vi.fn().mockReturnValue({ run: vi.fn() });
  const config = fakeConfigService(values);
  return { config, breakers: { create } as unknown as CircuitBreakerFactory, create };
}

describe('createMailTransport', () => {
  it('falls back to the log sink outside production', () => {
    const { config, breakers } = build({ 'app.env': 'development' });
    expect(createMailTransport(config, breakers)).toBeInstanceOf(LogMailTransport);
  });

  it('refuses to boot in production without an SMTP URL', () => {
    const { config, breakers } = build({ 'app.env': 'production' });
    expect(() => createMailTransport(config, breakers)).toThrow(/SMTP_URL is required in production/);
  });

  it('refuses an SMTP URL with no sender, which most relays reject anyway', () => {
    const { config, breakers } = build({ 'app.env': 'development', 'mail.smtpUrl': 'smtp://mail.test:1025' });
    expect(() => createMailTransport(config, breakers)).toThrow(/MAIL_FROM is required/);
  });

  // The loopback default is what `.env.example` ships, so this is the copied-dev-file case.
  it('refuses to boot in production against a loopback relay', () => {
    const { config, breakers } = build({
      'app.env': 'production',
      'mail.smtpUrl': 'smtp://localhost:1025',
      'mail.from': 'shop@test.local',
      'mail.timeoutMs': 10_000,
    });
    expect(() => createMailTransport(config, breakers)).toThrow(/loopback relay in production/);
  });

  it('leaves the loopback relay alone outside production', () => {
    const { config, breakers } = build({
      'app.env': 'development',
      'mail.smtpUrl': 'smtp://127.0.0.1:1025',
      'mail.from': 'shop@test.local',
      'mail.timeoutMs': 10_000,
    });
    expect(createMailTransport(config, breakers)).toBeInstanceOf(SmtpMailTransport);
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
