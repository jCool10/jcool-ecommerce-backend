import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

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

export interface MetricsScrape {
  text: string;
  /** The first series of `name` carrying every label given; undefined when there is none. */
  value(name: string, labels?: Record<string, string>): number | undefined;
  has(name: string): boolean;
}

const SAMPLE = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/;
const LABEL = /(\w+)="((?:[^"\\]|\\.)*)"/g;

/** One scrape of /metrics from an app booted with `METRICS_TOKEN: E2E_METRICS_TOKEN`. */
export async function scrapeMetrics(app: INestApplication): Promise<MetricsScrape> {
  const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
  const samples = text.split('\n').flatMap((line) => {
    const match = SAMPLE.exec(line);
    if (!match) return [];
    const labels = Object.fromEntries([...(match[2] ?? '').matchAll(LABEL)].map(([, key, value]) => [key, value]));
    return [{ name: match[1], labels, value: Number(match[3]) }];
  });
  return {
    text,
    value: (name, wanted = {}) =>
      samples.find(
        (sample) =>
          sample.name === name && Object.entries(wanted).every(([key, value]) => sample.labels[key] === value),
      )?.value,
    has: (name) => samples.some((sample) => sample.name === name),
  };
}
