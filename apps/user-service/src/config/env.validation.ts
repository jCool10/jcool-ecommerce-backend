import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Min, MinLength } from 'class-validator';
import { MIN_BUCKET_KEY_LENGTH } from '@jcool/id-codec';
import {
  AppEnv,
  DatabaseEnv,
  EmptyEnv,
  MailEnv,
  NodeEnv,
  ObservabilityEnv,
  RedisEnv,
  ResilienceEnv,
  RetentionEnv,
  ThrottleEnv,
  validateEnv,
} from '@jcool/platform/config';

const PlatformEnv = RetentionEnv(
  MailEnv(ResilienceEnv(ObservabilityEnv(RedisEnv(DatabaseEnv(ThrottleEnv(AppEnv(EmptyEnv))))))),
);

// configuration.ts compares against these literals, so '0' and '1' are refused rather than misread.
const BOOLEAN_STRINGS = ['true', 'false'];

/** Bounds only; defaults live in configuration.ts. */
export class EnvironmentVariables extends PlatformEnv {
  // Permanent, and the api's value: see the api's env.validation for why it can never rotate.
  @IsString()
  @MinLength(MIN_BUCKET_KEY_LENGTH)
  IDENTITY_BUCKET_KEY!: string;

  @IsOptional()
  @IsIn(BOOLEAN_STRINGS)
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
  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  REFRESH_TOKEN_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  EMAIL_VERIFICATION_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  PASSWORD_RESET_TTL?: string;

  @IsOptional()
  @IsIn(BOOLEAN_STRINGS)
  AUTH_REQUIRE_VERIFIED_EMAIL?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_MEMORY_COST?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_TIME_COST?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_PARALLELISM?: number;

  // The gateway's internal load balancer, never a single replica.
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  ID_SERVICE_URL!: string;

  @IsOptional()
  @Type(() => Number)
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

  @IsOptional()
  @IsIn(BOOLEAN_STRINGS)
  SESSION_EPOCH_RECONCILE_ENABLED?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  SESSION_EPOCH_RECONCILE_INTERVAL_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  RETENTION_AUTH_TOKEN_GRACE_DAYS?: number;

  // A revoked token that comes back is the reuse signal; see the api's floor.
  @IsOptional()
  @Type(() => Number)
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
