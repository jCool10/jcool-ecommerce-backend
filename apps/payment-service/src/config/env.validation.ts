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
  RetentionEnv,
  StrictInt,
  validateEnv,
} from '@jcool/platform/config';

// One member: the enum rejects a typo instead of letting it pick a gateway that does not exist.
export enum PaymentProvider {
  Stripe = 'stripe',
}

const PlatformEnv = RetentionEnv(ResilienceEnv(ObservabilityEnv(RedisEnv(DatabaseEnv(AppEnv(EmptyEnv))))));

const HTTP_URL = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

/** Bounds only; defaults live in configuration.ts. The shared ones match the api's. */
export class EnvironmentVariables extends PlatformEnv {
  // The gateway's internal load balancer, never a single replica.
  @IsUrl(HTTP_URL)
  ID_SERVICE_URL!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ID_SERVICE_TIMEOUT_MS?: number;

  // Optional, like every caller token: the guard is what refuses a boot with none.
  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_API?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_API_PREVIOUS?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_ORDER_SERVICE?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS?: string;

  // A blank prefix would produce a different key layout rather than fall back to the default.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  QUEUE_PREFIX?: string;

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
  @IsStrictBoolean()
  RECONCILE_ENABLED?: string;

  // Min 1000 so a typo can't turn the sweep into a busy loop against Stripe.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1000)
  RECONCILE_INTERVAL_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(500)
  RECONCILE_BATCH_SIZE?: number;

  // 0 is legal: e2e drives the sweep deterministically.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  ORDER_STALE_THRESHOLD_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  RETENTION_OUTBOX_DAYS?: number;

  // Tracks Stripe's redelivery window (~72h), not the queue's.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(14)
  RETENTION_WEBHOOK_EVENT_DAYS?: number;

  @IsOptional()
  @IsEnum(PaymentProvider)
  PAYMENT_PROVIDER?: PaymentProvider;

  // Optional so dev can boot without one; the Stripe adapter refuses to construct when it is absent.
  @IsOptional()
  @IsString()
  @MinLength(16)
  PAYMENT_WEBHOOK_SECRET?: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  PAYMENT_WEBHOOK_TOLERANCE_SEC?: number;

  @IsOptional()
  @IsString()
  @MinLength(8)
  STRIPE_SECRET_KEY?: string;

  // Not @IsUrl: the value carries Stripe's {CHECKOUT_SESSION_ID} template.
  @IsOptional()
  @IsString()
  STRIPE_SUCCESS_URL?: string;

  @IsOptional()
  @IsString()
  STRIPE_CANCEL_URL?: string;

  // Zero is legal: the production-mode system stack runs against a fake Stripe with no floor.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  PAYMENT_SESSION_MIN_TTL_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  PAYMENT_SESSION_EXPIRY_MARGIN_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(500)
  PAYMENT_CAPTURE_TIMEOUT_MS?: number;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const env = validateEnv(EnvironmentVariables, config);
  // Without a key the adapter fabricates sessions no buyer can pay, which only test and dev may run on.
  if (env.NODE_ENV === NodeEnv.Production && (!env.STRIPE_SECRET_KEY || !env.STRIPE_SUCCESS_URL)) {
    throw new Error('Environment validation failed -> STRIPE_SECRET_KEY/STRIPE_SUCCESS_URL: required in production');
  }
  return env;
}
