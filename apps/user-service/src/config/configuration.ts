// Env is already validated (env.validation.ts); the defaults for omitted vars live here.
import {
  appConfig,
  databaseConfig,
  mailConfig,
  observabilityConfig,
  parseIntOr,
  redisConfig,
  resilienceConfig,
  retentionConfig,
  throttleConfig,
} from '@jcool/platform/config';

export default () => ({
  ...appConfig(),
  ...observabilityConfig({ serviceName: 'jcool-user-service' }),
  ...databaseConfig(),
  ...redisConfig(),
  auth: {
    // Must equal the api's: both sides of a cutover hand out tokens that live this long.
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '5m',
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
    emailVerificationTtl: process.env.EMAIL_VERIFICATION_TTL ?? '24h',
    passwordResetTtl: process.env.PASSWORD_RESET_TTL ?? '1h',
    requireVerifiedEmail: process.env.AUTH_REQUIRE_VERIFIED_EMAIL === 'true',
    // Accepts the api's legacy tokens until the cutover window closes.
    hs256Enabled: process.env.AUTH_HS256_ENABLED !== 'false',
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    // Set to the api's JWT_ACCESS_SECRET, so CSRF cookies already out there stay valid here.
    csrfSecret: process.env.CSRF_SECRET,
    es256PrivateKeys: process.env.JWT_ES256_PRIVATE_KEYS,
    es256ActiveKid: process.env.JWT_ES256_ACTIVE_KID,
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  },
  identity: {
    bucketKey: process.env.IDENTITY_BUCKET_KEY,
    pinBootstrap: process.env.IDENTITY_PIN_BOOTSTRAP === 'true',
  },
  idService: {
    url: process.env.ID_SERVICE_URL,
    // Covers the gateway's retries across replicas, not one attempt.
    timeoutMs: parseIntOr(process.env.ID_SERVICE_TIMEOUT_MS, 2_000),
  },
  internalApi: {
    tokens: [process.env.INTERNAL_API_TOKEN, process.env.INTERNAL_API_TOKEN_PREVIOUS].filter((token): token is string =>
      Boolean(token),
    ),
  },
  sessionEpoch: {
    // Off only where a test drives the pass itself.
    reconcileEnabled: process.env.SESSION_EPOCH_RECONCILE_ENABLED !== 'false',
    reconcileIntervalMs: parseIntOr(process.env.SESSION_EPOCH_RECONCILE_INTERVAL_MS, 5_000),
  },
  ...mailConfig(),
  argon2: {
    // OWASP-minimum argon2id params (m=19 MiB, t=2, p=1).
    memoryCost: parseIntOr(process.env.ARGON2_MEMORY_COST, 19_456),
    timeCost: parseIntOr(process.env.ARGON2_TIME_COST, 2),
    parallelism: parseIntOr(process.env.ARGON2_PARALLELISM, 1),
  },
  ...throttleConfig(),
  retention: {
    ...retentionConfig().retention,
    authTokenGraceDays: parseIntOr(process.env.RETENTION_AUTH_TOKEN_GRACE_DAYS, 7),
    refreshTokenGraceDays: parseIntOr(process.env.RETENTION_REFRESH_TOKEN_GRACE_DAYS, 30),
  },
  ...resilienceConfig(),
});
