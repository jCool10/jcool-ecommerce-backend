// Typed config factory grouped by concern; callers read via config.get('app.port').
// Env is already validated (env.validation.ts). Defaults applied here when omitted.

// Express `trust proxy` value: false (off), true (trust all — spoofable), a hop count,
// or a subnet/CSV. Off unless TRUST_PROXY is set.
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : raw;
}

// Sentry performance sampling: a positive fraction enables tracing; 0/absent → errors only. Returns
// undefined (never literal 0) so callers can omit the key — an explicit 0 turns Sentry's own http
// spans on and duplicates our OTel spans (see instrumentation.ts).
function parseTracesSampleRate(raw: string | undefined): number | undefined {
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

export default () => ({
  app: {
    env: process.env.NODE_ENV,
    port: parseInt(process.env.PORT ?? '3000', 10),
    // Fail-safe: on in dev/test, off in production unless SWAGGER_ENABLED=true.
    swaggerEnabled:
      process.env.SWAGGER_ENABLED === 'true' ||
      (process.env.SWAGGER_ENABLED !== 'false' && process.env.NODE_ENV !== 'production'),
    // Secure flag on auth cookies: on in production, off elsewhere (so http dev/e2e round-trips); COOKIE_SECURE overrides.
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production',
    // Cross-origin allow-list (comma-separated); empty → CORS off (same-origin only), the safe default.
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Public base URL used to build links in outbound email (verification, etc.).
    publicUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:3000',
    // Reverse-proxy trust for req.ip (throttle + audit). Off by default (anti-spoof); set behind a trusted proxy.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    // How long /health/ready keeps 503-ing after SIGTERM before the server closes (graceful
    // drain). 0 = shut down immediately (tests/dev); set ~5000 under a load balancer.
    shutdownGracePeriodMs: parseInt(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? '0', 10),
  },
  log: {
    // pino level: verbose in dev, lean in prod; LOG_LEVEL overrides either way.
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  },
  metrics: {
    // Bearer token for GET /metrics. Undefined → open in dev, hidden in prod (MetricsTokenGuard).
    token: process.env.METRICS_TOKEN,
  },
  tracing: {
    // Mirrors instrumentation.ts (which reads process.env directly, before this runs) for a typed config surface.
    enabled: process.env.OTEL_ENABLED === 'true',
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'jcool-api',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
  },
  sentry: {
    // Typed mirror of the Sentry gating in instrumentation.ts (which inits before this runs).
    enabled: Boolean(process.env.SENTRY_DSN),
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    // Positive fraction → performance tracing; 0/absent → error-only (undefined, not literal 0).
    tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    // Short access-token life (defense-in-depth): caps exposure if the jti denylist is ever bypassed.
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '5m',
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
    // Lifetime of an email-verification token (duration form, e.g. "24h").
    emailVerificationTtl: process.env.EMAIL_VERIFICATION_TTL ?? '24h',
    // Password-reset token lifetime — short by design (high-value credential), defaults to 1h.
    passwordResetTtl: process.env.PASSWORD_RESET_TTL ?? '1h',
    // When true, an unverified account cannot log in (403 after correct creds). Off by default.
    requireVerifiedEmail: process.env.AUTH_REQUIRE_VERIFIED_EMAIL === 'true',
  },
  argon2: {
    // OWASP-minimum argon2id params (m=19 MiB, t=2, p=1); override via env to tune.
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '19456', 10),
    timeCost: parseInt(process.env.ARGON2_TIME_COST ?? '2', 10),
    parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
  },
  throttle: {
    // Rate-limiting kill-switch; on by default (THROTTLE_ENABLED=false disables — load tests, e2e).
    enabled: process.env.THROTTLE_ENABLED !== 'false',
  },
});
