import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerFactory, ResilienceModule } from '@shared/resilience';
import { LogMailTransport } from './log-mail.transport';
import { MAIL_TRANSPORT, type MailTransportPort } from './mail-transport.port';
import { MAIL_BREAKER, SmtpMailTransport } from './smtp-mail.transport';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** A relay on this machine's own loopback is a developer's catcher, never a route off the host. */
function isLoopbackRelay(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.replace(/^\[|]$/g, ''));
  } catch {
    return false;
  }
}

/**
 * The presence of `SMTP_URL` is the switch, the way `SENTRY_DSN` is: a separate MAIL_ENABLED flag
 * could disagree with it.
 */
export function createMailTransport(config: ConfigService, breakers: CircuitBreakerFactory): MailTransportPort {
  const url = config.get<string>('mail.smtpUrl')?.trim();
  const isProduction = config.get<string>('app.env') === 'production';

  if (!url) {
    // Falling back to the log sink in production would leave every verification and reset link
    // unsent while the app looked healthy, so a missing URL is a boot failure, not a downgrade.
    if (isProduction) {
      throw new Error('SMTP_URL is required in production: without it mail is written to the log and never delivered');
    }
    return new LogMailTransport();
  }

  // `.env.example` ships a loopback URL, so this is what a copied dev file looks like on a server:
  // every send succeeds against a catcher nobody reads, which is indistinguishable from a working
  // relay in every metric the app has.
  if (isProduction && isLoopbackRelay(url)) {
    throw new Error(
      'SMTP_URL points at a loopback relay in production: that address is a local mail catcher, so every message would be accepted and never delivered',
    );
  }

  const from = config.get<string>('mail.from')?.trim();
  if (!from) {
    throw new Error('MAIL_FROM is required when SMTP_URL is set');
  }

  const timeoutMs = config.getOrThrow<number>('mail.timeoutMs');
  return new SmtpMailTransport({
    url,
    from,
    timeoutMs,
    breaker: breakers.create(MAIL_BREAKER, { timeoutMs }),
  });
}

@Module({
  imports: [ResilienceModule],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService, CircuitBreakerFactory],
      useFactory: createMailTransport,
    },
  ],
  exports: [MAIL_TRANSPORT],
})
export class MailModule {}
