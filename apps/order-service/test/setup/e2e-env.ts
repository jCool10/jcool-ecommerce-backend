// Side-effect free: the Vitest config imports this too, because AppModule validates env on import.

// Nothing listens here; createTestApp swaps in each stub's real port.
const NOTHING_LISTENS = 'http://127.0.0.1:1';

export const E2E_BASE_ENV: Record<string, string> = {
  AUTH_JWKS_URL: `${NOTHING_LISTENS}/.well-known/jwks.json`,
  JWT_ISSUER: 'https://users.jcool.test',
  JWT_AUDIENCE: 'jcool-api',
  USER_SERVICE_URL: NOTHING_LISTENS,
  USER_SERVICE_TOKEN: 'e2e-user-service-token-not-a-real-secret',
  ID_SERVICE_URL: NOTHING_LISTENS,
  API_SERVICE_URL: NOTHING_LISTENS,
  API_SERVICE_TOKEN: 'e2e-api-service-token-not-a-real-secret-0',
  INVENTORY_SERVICE_URL: NOTHING_LISTENS,
  INVENTORY_SERVICE_TOKEN: 'e2e-inventory-service-token-not-a-secret-0',
  PAYMENT_SERVICE_URL: NOTHING_LISTENS,
  PAYMENT_SERVICE_TOKEN: 'e2e-payment-service-token-not-a-secret-00',
  // The 12-16 contender races hold a pool client each while they queue on the stub's answer.
  DB_POOL_MAX: '16',
  // Background drivers stay off; a suite that needs one turns it on or drives the use case.
  OUTBOX_RELAY_ENABLED: 'false',
  QUEUE_WORKER_ENABLED: 'false',
  RETENTION_ENABLED: 'false',
  CHECKOUT_REAPER_ENABLED: 'false',
  CHECKOUT_INVARIANT_ENABLED: 'false',
  THROTTLE_ENABLED: 'false',
  // The drain window is a plain sleep inside app.close(), paid by every app in every file.
  SHUTDOWN_GRACE_PERIOD_MS: '0',
};
