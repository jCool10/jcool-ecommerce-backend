import { IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, Min, MinLength } from 'class-validator';
import {
  AppEnv,
  DatabaseEnv,
  EmptyEnv,
  IsStrictBoolean,
  MailEnv,
  NodeEnv,
  ObservabilityEnv,
  RedisEnv,
  ResilienceEnv,
  RetentionEnv,
  StrictInt,
  ThrottleEnv,
  validateEnv,
} from '@jcool/platform/config';

const PlatformEnv = RetentionEnv(
  MailEnv(ResilienceEnv(ObservabilityEnv(RedisEnv(DatabaseEnv(ThrottleEnv(AppEnv(EmptyEnv))))))),
);

// Same grammar as durationToMs, which throws on a bare number rather than guess its unit.
const POSITIVE_DURATION = /^[1-9]\d*(ms|s|m|h|d)$/i;
const ANY_DURATION = /^\d+(ms|s|m|h|d)$/i;
const DURATION_MESSAGE = '$property must be a number with a unit (ms, s, m, h or d), e.g. 15m';

/** Bounds only; defaults live in configuration.ts. */
export class EnvironmentVariables extends PlatformEnv {
  @IsOptional()
  @IsStrictBoolean()
  IDENTITY_PIN_BOOTSTRAP?: string;

  // `kid:pem` entries, comma-separated; parsed and checked when the signer is built.
  @IsString()
  @IsNotEmpty()
  JWT_ES256_PRIVATE_KEYS!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ES256_ACTIVE_KID!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ISSUER!: string;

  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE!: string;

  @IsString()
  @MinLength(32)
  CSRF_SECRET!: string;

  @IsOptional()
  @Matches(POSITIVE_DURATION, { message: DURATION_MESSAGE })
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @Matches(POSITIVE_DURATION, { message: DURATION_MESSAGE })
  REFRESH_TOKEN_TTL?: string;

  @IsOptional()
  @Matches(POSITIVE_DURATION, { message: DURATION_MESSAGE })
  EMAIL_VERIFICATION_TTL?: string;

  @IsOptional()
  @Matches(POSITIVE_DURATION, { message: DURATION_MESSAGE })
  PASSWORD_RESET_TTL?: string;

  // How long a token that was just rotated away is refused without revoking its family. 0s turns
  // the window off.
  @IsOptional()
  @Matches(ANY_DURATION, { message: DURATION_MESSAGE })
  REFRESH_REUSE_GRACE?: string;

  @IsOptional()
  @IsStrictBoolean()
  AUTH_REQUIRE_VERIFIED_EMAIL?: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  ARGON2_MEMORY_COST?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  ARGON2_TIME_COST?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  ARGON2_PARALLELISM?: number;

  // The gateway's internal load balancer, never a single replica.
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  ID_SERVICE_URL!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ID_SERVICE_TIMEOUT_MS?: number;

  @IsString()
  @MinLength(32)
  INTERNAL_API_TOKEN!: string;

  // Accepted alongside the current one while callers move to it.
  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_API_TOKEN_PREVIOUS?: string;

  // The inventory-service reads session epochs on its admin routes. Optional, so the token can be
  // set before that service first deploys and dropped again after it stops calling.
  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE_PREVIOUS?: string;

  // The order-service reads epochs and, for the order.paid mail, user summaries.
  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_ORDER_SERVICE?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS?: string;

  @IsOptional()
  @IsStrictBoolean()
  SESSION_EPOCH_RECONCILE_ENABLED?: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1_000)
  SESSION_EPOCH_RECONCILE_INTERVAL_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  RETENTION_AUTH_TOKEN_GRACE_DAYS?: number;

  // A revoked token that comes back is the reuse signal; see the api's floor.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(30)
  RETENTION_REFRESH_TOKEN_GRACE_DAYS?: number;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const env = validateEnv(EnvironmentVariables, config);
  if (env.NODE_ENV === NodeEnv.Production) {
    const missing = [
      // Behind the gateway, unset keys every IP throttle on the gateway's address.
      env.TRUST_PROXY === undefined && 'TRUST_PROXY',
      // The default is localhost, which would go out in every mailed link.
      env.APP_PUBLIC_URL === undefined && 'APP_PUBLIC_URL',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Environment validation failed -> ${missing.join(', ')}: required in production`);
    }
  }
  return env;
}
