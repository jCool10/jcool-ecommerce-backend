// Side-effect free: the Vitest config imports this too, because AppModule validates env on import.

export const E2E_JWT_ISSUER = 'https://auth.jcool.test';
export const E2E_JWT_AUDIENCE = 'jcool-api';
/** The order-service's, its only caller. */
export const E2E_CALLER_TOKEN = 'e2e-order-service-caller-token-not-a-secret-0';
export const E2E_USER_SERVICE_TOKEN = 'e2e-user-service-token-not-a-real-secret-000';
/** Validation wants at least 16 characters. */
export const E2E_METRICS_TOKEN = 'e2e-metrics-token-not-a-real-secret';
// Nothing listens here; createTestApp swaps in the stubs' real ports.
const NOTHING_LISTENS = 'http://127.0.0.1:1';

export const E2E_BASE_ENV: Record<string, string> = {
  JWT_ISSUER: E2E_JWT_ISSUER,
  JWT_AUDIENCE: E2E_JWT_AUDIENCE,
  INTERNAL_CALLER_TOKEN_ORDER_SERVICE: E2E_CALLER_TOKEN,
  USER_SERVICE_TOKEN: E2E_USER_SERVICE_TOKEN,
  METRICS_TOKEN: E2E_METRICS_TOKEN,
  AUTH_JWKS_URL: `${NOTHING_LISTENS}/.well-known/jwks.json`,
  USER_SERVICE_URL: NOTHING_LISTENS,
  ID_SERVICE_URL: NOTHING_LISTENS,
  CATALOG_PUBLIC_URL: NOTHING_LISTENS,
  // A suite that needs the sweep drives the use case directly.
  INVENTORY_HOLD_SWEEP_ENABLED: 'false',
  SHUTDOWN_GRACE_PERIOD_MS: '0',
};
