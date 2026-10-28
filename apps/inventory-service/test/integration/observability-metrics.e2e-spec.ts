import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { referencedMetricNames } from '@jcool/testing/referenced-metric-names';
import { closeAppAfterAll } from '../setup/harness';
import { metricsAuthHeader } from '../setup/metrics.helper';
import { createTestApp } from '../setup/test-app.factory';

const INFRA = resolve(__dirname, '../../../../infra');

// Recorded by this service; the api records some of them too, under its own job.
const OWNED = [
  'http_requests_total',
  'http_request_duration_seconds',
  'circuit_breaker_state',
  'circuit_breaker_calls_total',
  'rate_limit_rejections_total',
  'tcc_branch_total',
  'nodejs_eventloop_lag_seconds',
  'nodejs_heap_size_used_bytes',
  'nodejs_heap_size_total_bytes',
];

describe('Metrics endpoint (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  closeAppAfterAll(() => app);

  it('answers 404 without the bearer token or with a wrong one', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
    await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader('wrong')).expect(404);
  });

  it('describes every metric it owns that the alert rules and dashboards query', async () => {
    const referenced = new Set(referencedMetricNames(INFRA));
    const owned = OWNED.filter((name) => referenced.has(name));

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    const described = new Set([...res.text.matchAll(/^# HELP (\S+)/gm)].map((match) => match[1]));
    expect(owned).toContain('http_requests_total');
    expect(owned.filter((name) => !described.has(name))).toEqual([]);
  });
});
