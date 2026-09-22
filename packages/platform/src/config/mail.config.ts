import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { parseIntOr } from './env-parsers';
import type { EnvBase } from './validate-env';

export function MailEnv<TBase extends EnvBase>(Base: TBase) {
  class MailEnv extends Base {
    // Connection URL (smtp://user:pass@host:587).
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    SMTP_URL?: string;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    MAIL_FROM?: string;

    // Capped below BullMQ's 30s job lock, which the order-confirmation send runs inside: past that the
    // queue reclaims the job mid-send, and the original delivery — already applied, already sent —
    // finishes without its lock and is filed as a dead letter.
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(100)
    @Max(25_000)
    MAIL_TIMEOUT_MS?: number;
  }
  return MailEnv;
}

export const mailConfig = () => ({
  mail: {
    // Presence is the switch, like SENTRY_DSN: set → real SMTP, unset → the log sink (and a refused
    // boot in production, where that sink would deliver nothing while looking healthy).
    smtpUrl: process.env.SMTP_URL,
    // Required once SMTP_URL is set — most relays reject a message without an envelope sender.
    from: process.env.MAIL_FROM,
    // Its own timeout, well above the shared breaker default: a mail server taking seconds is
    // normal, and nobody waits on it — mail is sent after its transaction has already committed.
    timeoutMs: parseIntOr(process.env.MAIL_TIMEOUT_MS, 10_000),
  },
});
