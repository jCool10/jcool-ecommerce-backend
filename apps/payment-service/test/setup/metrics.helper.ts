import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { E2E_METRICS_TOKEN } from './e2e-env';

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
