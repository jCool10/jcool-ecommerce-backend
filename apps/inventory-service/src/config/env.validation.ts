import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, Min, MinLength } from 'class-validator';
import {
  AppEnv,
  DatabaseEnv,
  EmptyEnv,
  IsStrictBoolean,
  NodeEnv,
  ObservabilityEnv,
  RedisEnv,
  ResilienceEnv,
  StrictInt,
  ThrottleEnv,
  validateEnv,
} from '@jcool/platform/config';

export enum InventoryLockStrategy {
  Pessimistic = 'pessimistic',
  Optimistic = 'optimistic',
}

const PlatformEnv = ResilienceEnv(ObservabilityEnv(RedisEnv(DatabaseEnv(ThrottleEnv(AppEnv(EmptyEnv))))));

const HTTP_URL = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

/** Bounds only; defaults live in configuration.ts. */
export class EnvironmentVariables extends PlatformEnv {
  // The gateway's internal load balancer, never a single replica.
  @IsUrl(HTTP_URL)
  ID_SERVICE_URL!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ID_SERVICE_TIMEOUT_MS?: number;

  @IsUrl(HTTP_URL)
  AUTH_JWKS_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ISSUER!: string;

  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE!: string;

  @IsUrl(HTTP_URL)
  USER_SERVICE_URL!: string;

  @IsString()
  @MinLength(32)
  USER_SERVICE_TOKEN!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  USER_SERVICE_TIMEOUT_MS?: number;

  // Optional, like every caller token: the guard is what refuses a boot with none.
  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_API?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_API_PREVIOUS?: string;

  // The public catalog the stock seed lists variants from.
  @IsUrl(HTTP_URL)
  CATALOG_PUBLIC_URL!: string;

  @IsOptional()
  @IsEnum(InventoryLockStrategy)
  INVENTORY_LOCK_STRATEGY?: InventoryLockStrategy;

  // Capped so a misconfig can't spin the CAS loop while it pins the stock row's write-lock.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  @Max(10)
  INVENTORY_OPTIMISTIC_MAX_RETRIES?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(30_000)
  INVENTORY_TRY_LOCK_TIMEOUT_MS?: number;

  @IsOptional()
  @IsStrictBoolean()
  INVENTORY_HOLD_SWEEP_ENABLED?: string;

  // Min 1000 so a typo can't turn the sweep into a busy loop opening transactions.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1000)
  INVENTORY_HOLD_SWEEP_INTERVAL_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(500)
  INVENTORY_HOLD_SWEEP_BATCH_SIZE?: number;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const env = validateEnv(EnvironmentVariables, config);
  // Behind the gateway, unset keys every admin throttle on the gateway's address.
  if (env.NODE_ENV === NodeEnv.Production && env.TRUST_PROXY === undefined) {
    throw new Error('Environment validation failed -> TRUST_PROXY: required in production');
  }
  return env;
}
