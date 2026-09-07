import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerFactory, ResilienceModule } from '@shared/resilience';
import { LogMailTransport } from './log-mail.transport';
import { MAIL_TRANSPORT, type MailTransportPort } from './mail-transport.port';
import { MAIL_BREAKER, SmtpMailTransport } from './smtp-mail.transport';

/**
 * Picks the transport from configuration: the presence of `SMTP_URL` is the switch, the way
 * `SENTRY_DSN` is — a separate MAIL_ENABLED flag could disagree with it.
 */
export function createMailTransport(config: ConfigService, breakers: CircuitBreakerFactory): MailTransportPort {
  const url = config.get<string>('mail.smtpUrl')?.trim();

  if (!url) {
    // The log transport delivers nothing. Falling back to it in production would leave every
    // verification and reset link unsent while the app looked healthy, so a missing URL is a boot
    // failure rather than a silent downgrade.
    if (config.get<string>('app.env') === 'production') {
      throw new Error('SMTP_URL is required in production: without it mail is written to the log and never delivered');
    }
    return new LogMailTransport();
  }

  const from = config.get<string>('mail.from')?.trim();
  if (!from) {
    throw new Error('MAIL_FROM is required when SMTP_URL is set');
  }

  return new SmtpMailTransport({
    url,
    from,
    breaker: breakers.create(MAIL_BREAKER, { timeoutMs: config.get<number>('mail.timeoutMs') }),
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
