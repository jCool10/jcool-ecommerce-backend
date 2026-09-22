// Side-effect free: the Vitest config imports this too, because AppModule validates env on import.

export const E2E_IDENTITY_BUCKET_KEY = 'e2e-identity-bucket-key-not-a-real-secret-000';
export const E2E_JWT_ISSUER = 'https://auth.jcool.test';
export const E2E_JWT_AUDIENCE = 'jcool';
export const E2E_ES256_KID = 'e2e-es256';
export const E2E_CSRF_SECRET = 'e2e-csrf-secret-not-a-real-secret-000000000000';
export const E2E_INTERNAL_API_TOKEN = 'e2e-internal-api-token-not-a-real-secret-000';
// Nothing listens here, so an app that reaches the id service without being told to fails loudly.
export const E2E_ID_SERVICE_URL = 'http://127.0.0.1:1';

export const E2E_BASE_ENV: Record<string, string> = {
  IDENTITY_BUCKET_KEY: E2E_IDENTITY_BUCKET_KEY,
  JWT_ES256_ACTIVE_KID: E2E_ES256_KID,
  JWT_ISSUER: E2E_JWT_ISSUER,
  JWT_AUDIENCE: E2E_JWT_AUDIENCE,
  CSRF_SECRET: E2E_CSRF_SECRET,
  INTERNAL_API_TOKEN: E2E_INTERNAL_API_TOKEN,
  ID_SERVICE_URL: E2E_ID_SERVICE_URL,
  // Background passes stay off; a suite that needs one drives it directly.
  SESSION_EPOCH_RECONCILE_ENABLED: 'false',
  RETENTION_ENABLED: 'false',
  SHUTDOWN_GRACE_PERIOD_MS: '0',
};
