import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, MinLength } from 'class-validator';
import { IsStrictBoolean } from './strict-env-decorators';
import type { EnvBase } from './validate-env';

export enum LogLevel {
  Trace = 'trace',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

const OTEL_TRACES_SAMPLERS = [
  'always_on',
  'always_off',
  'traceidratio',
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
];

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
    @IsStrictBoolean()
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

    // Read by the SDK itself. It samples everything on a value it cannot read and says so only through
    // its diag logger, so a typo would undo a lowered ratio, or the ratio-0 off switch, silently.
    @IsOptional()
    @IsIn(OTEL_TRACES_SAMPLERS)
    OTEL_TRACES_SAMPLER?: string;

    @IsOptional()
    @Matches(/^(0(\.\d+)?|1(\.0+)?)$/, { message: 'OTEL_TRACES_SAMPLER_ARG must be a ratio from 0 to 1, like 0.25' })
    OTEL_TRACES_SAMPLER_ARG?: string;

    // Unset (dev/test) → the SDK never initializes and captureException is a silent no-op. Read in
    // instrumentation.ts; declared here so a blank value fails boot.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    SENTRY_DSN?: string;

    // Unset → logs go to stdout only. Set → every line is also pushed to this Loki. A URL rather than a
    // plain string: pino-loki swallows a bad one on every push instead of failing the boot.
    @IsOptional()
    @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
    LOKI_URL?: string;
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
  loki: {
    url: process.env.LOKI_URL,
  },
});
