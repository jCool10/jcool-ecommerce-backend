import { IsBooleanString, IsEnum, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import type { EnvBase } from './validate-env';

export enum LogLevel {
  Trace = 'trace',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

export function ObservabilityEnv<TBase extends EnvBase>(Base: TBase) {
  class ObservabilityEnv extends Base {
    @IsOptional()
    @IsEnum(LogLevel)
    LOG_LEVEL?: LogLevel;

    @IsOptional()
    @IsString()
    @MinLength(16)
    METRICS_TOKEN?: string;

    // The OTel SDK (instrumentation.ts) starts only when this is "true".
    @IsOptional()
    @IsBooleanString()
    OTEL_ENABLED?: string;

    // service.name on every span; read in instrumentation.ts, declared here so a bad value fails boot.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    OTEL_SERVICE_NAME?: string;

    // Base endpoint of the Collector; the traces path (/v1/traces) is appended to it.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;

    // Unset (dev/test) → the SDK never initializes and captureException is a silent no-op. Read in
    // instrumentation.ts; declared here so a blank value fails boot.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    SENTRY_DSN?: string;
  }
  return ObservabilityEnv;
}

export const observabilityConfig = (defaults: { serviceName: string }) => ({
  log: {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  },
  metrics: {
    // Undefined → /metrics is open in dev and hidden in prod (MetricsTokenGuard).
    token: process.env.METRICS_TOKEN,
  },
  tracing: {
    // A typed mirror of instrumentation.ts, which reads process.env directly because it runs first.
    enabled: process.env.OTEL_ENABLED === 'true',
    serviceName: process.env.OTEL_SERVICE_NAME ?? defaults.serviceName,
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
  },
  sentry: {
    enabled: Boolean(process.env.SENTRY_DSN),
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
  },
});
