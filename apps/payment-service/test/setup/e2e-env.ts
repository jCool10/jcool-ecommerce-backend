// Side-effect free: the Vitest config imports this too, because AppModule validates env on import.

export const E2E_API_CALLER_TOKEN = 'e2e-api-caller-token-not-a-real-secret-00000';
/** Validation wants at least 16 characters. */
export const E2E_METRICS_TOKEN = 'e2e-metrics-token-not-a-real-secret';
export const E2E_WEBHOOK_SECRET = 'whsec_e2e_not_a_real_secret_00000';
// Nothing listens here; createTestApp swaps in the stub's real port.
const NOTHING_LISTENS = 'http://127.0.0.1:1';

export const E2E_BASE_ENV: Record<string, string> = {
  INTERNAL_CALLER_TOKEN_API: E2E_API_CALLER_TOKEN,
  METRICS_TOKEN: E2E_METRICS_TOKEN,
  PAYMENT_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
  ID_SERVICE_URL: NOTHING_LISTENS,
  // Background drivers stay off; a suite that needs one turns it on or drives the use case.
  OUTBOX_RELAY_ENABLED: 'false',
  RECONCILE_ENABLED: 'false',
  RETENTION_ENABLED: 'false',
  SHUTDOWN_GRACE_PERIOD_MS: '0',
};
