import { IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, Min, MinLength } from 'class-validator';
import { MIN_INBOX_RETENTION_DAYS } from '@jcool/messaging';
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
import { CheckoutSagaEnv, assertCheckoutSagaEnv } from './checkout-saga.env';

const PlatformEnv = RetentionEnv(
  MailEnv(ResilienceEnv(ObservabilityEnv(RedisEnv(DatabaseEnv(ThrottleEnv(AppEnv(EmptyEnv))))))),
);

const HTTP_URL = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

/** Bounds only; defaults live in configuration.ts. Cross-field rules are in checkout-saga.env.ts. */
export class EnvironmentVariables extends CheckoutSagaEnv(PlatformEnv) {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  QUEUE_PREFIX?: string;

  @IsOptional()
  @IsStrictBoolean()
  QUEUE_WORKER_ENABLED?: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(50)
  QUEUE_WORKER_CONCURRENCY?: number;

  // The backoff doubles, so ten tries already stretch the last wait past eight minutes.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(10)
  QUEUE_CONSUMER_ATTEMPTS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(60_000)
  QUEUE_CONSUMER_BACKOFF_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(30)
  ORDER_PAID_CONSUMER_ATTEMPTS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ORDER_PAID_CONSUMER_BACKOFF_CAP_MS?: number;

  @IsOptional()
  @IsStrictBoolean()
  OUTBOX_RELAY_ENABLED?: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  OUTBOX_POLL_MS?: number;

  // The publish runs inside the polling transaction, so this is also how long row locks are held.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(1000)
  OUTBOX_BATCH_SIZE?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  RETENTION_IDEMPOTENCY_GRACE_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  RETENTION_OUTBOX_DAYS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  RETENTION_REJECTED_ORDER_DAYS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(MIN_INBOX_RETENTION_DAYS)
  RETENTION_INBOX_DAYS?: number;

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

  // The user-service's INTERNAL_CALLER_TOKEN_ORDER_SERVICE.
  @IsString()
  @MinLength(32)
  USER_SERVICE_TOKEN!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  USER_SERVICE_TIMEOUT_MS?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  USER_DIRECTORY_NOT_FOUND_GRACE?: string;

  @IsUrl(HTTP_URL)
  ID_SERVICE_URL!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ID_SERVICE_TIMEOUT_MS?: number;

  @IsUrl(HTTP_URL)
  API_SERVICE_URL!: string;

  // The api's INTERNAL_CALLER_TOKEN_ORDER_SERVICE.
  @IsString()
  @MinLength(32)
  API_SERVICE_TOKEN!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  API_SERVICE_TIMEOUT_MS?: number;

  @IsUrl(HTTP_URL)
  INVENTORY_SERVICE_URL!: string;

  // The inventory-service's INTERNAL_CALLER_TOKEN_ORDER_SERVICE.
  @IsString()
  @MinLength(32)
  INVENTORY_SERVICE_TOKEN!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  INVENTORY_COMMAND_TIMEOUT_MS?: number;

  @IsUrl(HTTP_URL)
  PAYMENT_SERVICE_URL!: string;

  // The payment-service's INTERNAL_CALLER_TOKEN_ORDER_SERVICE.
  @IsString()
  @MinLength(32)
  PAYMENT_SERVICE_TOKEN!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1000)
  PAYMENT_COMMAND_TIMEOUT_MS?: number;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const env = validateEnv(EnvironmentVariables, config);
  // Throttled per user and per IP behind the gateway, so an unset value keys every IP tier on the proxy.
  if (env.NODE_ENV === NodeEnv.Production && env.TRUST_PROXY === undefined) {
    throw new Error(
      'Environment validation failed -> TRUST_PROXY: required in production; set the proxies to trust (subnets or a hop count), or "false" when nothing proxies',
    );
  }
  assertCheckoutSagaEnv(env);
  return env;
}
