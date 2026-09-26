import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { IsStrictBoolean, StrictInt } from './strict-env-decorators';
import type { EnvBase } from './validate-env';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export function AppEnv<TBase extends EnvBase>(Base: TBase) {
  class AppEnv extends Base {
    @IsEnum(NodeEnv)
    NODE_ENV!: NodeEnv;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    @Max(65535)
    PORT?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(0)
    SHUTDOWN_GRACE_PERIOD_MS?: number;

    @IsOptional()
    @IsStrictBoolean()
    SWAGGER_ENABLED?: string;

    // Plain string, not @IsUrl, so localhost and other non-TLD hosts validate.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    APP_PUBLIC_URL?: string;

    @IsOptional()
    @IsStrictBoolean()
    COOKIE_SECURE?: string;

    @IsOptional()
    @IsString()
    CORS_ORIGINS?: string;

    // A hop count, a subnet/CSV, or "true"/"false".
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    TRUST_PROXY?: string;
  }
  return AppEnv;
}

// `true` trusts every hop and makes req.ip spoofable; a hop count or a subnet/CSV is the safe form.
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : raw;
}

export const appConfig = () => ({
  app: {
    env: process.env.NODE_ENV,
    port: parseInt(process.env.PORT ?? '3000', 10),
    swaggerEnabled:
      process.env.SWAGGER_ENABLED === 'true' ||
      (process.env.SWAGGER_ENABLED !== 'false' && process.env.NODE_ENV !== 'production'),
    // Off outside production so auth cookies survive an http dev/e2e round-trip.
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production',
    // Empty → CORS off (same-origin only), the safe default.
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Base URL for links in outbound email (verification, reset).
    publicUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:3000',
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    // How long /health/ready keeps 503-ing after SIGTERM before the server closes (graceful drain).
    // 0 = shut down immediately (tests/dev); set ~5000 under a load balancer.
    shutdownGracePeriodMs: parseInt(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? '0', 10),
  },
});
