/** Validation wants at least 16 characters. */
export const E2E_METRICS_TOKEN = 'e2e-metrics-token-not-a-real-secret';

export function metricsAuthHeader(token: string = E2E_METRICS_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
