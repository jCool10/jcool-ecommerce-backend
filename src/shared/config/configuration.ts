// Typed config factory grouped by concern; callers read via config.get('app.port').
// Env is already validated (env.validation.ts). Defaults applied here when omitted.
export default () => ({
  app: {
    env: process.env.NODE_ENV,
    port: parseInt(process.env.PORT ?? '3000', 10),
    // Fail-safe: on in dev/test, off in production unless SWAGGER_ENABLED=true.
    swaggerEnabled:
      process.env.SWAGGER_ENABLED === 'true' ||
      (process.env.SWAGGER_ENABLED !== 'false' && process.env.NODE_ENV !== 'production'),
    // Secure flag on auth cookies. Defaults to on in production (HTTPS) and off
    // otherwise so http dev/e2e can round-trip cookies; COOKIE_SECURE overrides
    // (e.g. staging behind a TLS proxy).
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production',
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    // Short access-token life (defense-in-depth): the jti denylist makes logout
    // immediate regardless, this caps the window if the denylist is ever bypassed.
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '5m',
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
  },
  argon2: {
    // OWASP-minimum argon2id params (m=19 MiB, t=2, p=1); override via env to tune.
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '19456', 10),
    timeCost: parseInt(process.env.ARGON2_TIME_COST ?? '2', 10),
    parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
  },
  throttle: {
    // Rate-limiting kill-switch. On by default; set THROTTLE_ENABLED=false to
    // disable enforcement (load tests, or the default e2e harness).
    enabled: process.env.THROTTLE_ENABLED !== 'false',
  },
});
