import { register } from 'prom-client';

/**
 * `/metrics` is bearer-guarded, so every suite that scrapes it needs a token the app was booted
 * with and a matching header. The value was per-file before, which proved nothing: the guard
 * compares against whatever `METRICS_TOKEN` the app read at compile time, and no test asserts one
 * file's token is rejected by another file's app.
 */

/** Schema requires ≥16 characters (`env.validation.ts`), so a shorter literal fails at boot. */
export const E2E_METRICS_TOKEN = 'e2e-metrics-token-not-a-real-secret';

export function metricsAuthHeader(token: string = E2E_METRICS_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * The default registry lives as long as the worker, and a metric is only registered once, so an app
 * booted after another one closed would scrape gauges still collecting from the closed app. Call it
 * between the two, never while an earlier app is still being scraped.
 */
export function clearMetricsRegistry(): void {
  register.clear();
}
