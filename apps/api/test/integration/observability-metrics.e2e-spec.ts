import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { createTestApp } from '../setup/test-app.factory';

const INFRA = resolve(__dirname, '../../../../infra');
const PROMQL_OPERATORS = new Set(['and', 'or', 'unless', 'offset', 'bool']);
// Scraped from Prometheus itself, Loki and the id-service, not from the api.
const NOT_THE_API = /^(up|loki_\w+|id_clock_\w+)$/;

function filesIn(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(extension))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
}

function ruleExpressions(): string[] {
  const exprs: string[] = [];
  for (const text of filesIn(join(INFRA, 'prometheus/rules'), '.yml')) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const match = /^(\s*)expr:\s*(.*)$/.exec(line);
      if (!match) return;
      if (!/^[|>]/.test(match[2])) {
        exprs.push(match[2]);
        return;
      }
      const indent = match[1].length;
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j += 1) {
        exprs.push(lines[j]);
      }
    });
  }
  return exprs;
}

function dashboardExpressions(): string[] {
  const exprs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'expr' && typeof value === 'string') exprs.push(value);
        else walk(value);
      }
    }
  };
  for (const text of filesIn(join(INFRA, 'grafana/provisioning/dashboards'), '.json')) walk(JSON.parse(text));
  return exprs;
}

// Skips functions (followed by a parenthesis) and recording rules (named with a colon).
function metricNames(exprs: string[]): string[] {
  const names = new Set<string>();
  for (const expr of exprs) {
    const bare = expr
      .replace(/"[^"]*"/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\b(by|without|on|ignoring)\s*\([^)]*\)/g, '');
    for (const token of bare.match(/(?<![\w.])[a-zA-Z_:][\w:]*(?![\w:]|\s*\()/g) ?? []) {
      if (PROMQL_OPERATORS.has(token) || token.includes(':') || NOT_THE_API.test(token)) continue;
      names.add(token.replace(/_(bucket|count|sum)$/, ''));
    }
  }
  return [...names].sort();
}

describe('Metrics endpoint (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    app = await createTestApp();
  });

  // Clears the token so the next file in this worker boots with /metrics unguarded.
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  it('answers 404 without the bearer token or with a wrong one', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
    await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer wrong').expect(404);
  });

  it('describes every api metric the alert rules and dashboards query', async () => {
    const referenced = metricNames([...ruleExpressions(), ...dashboardExpressions()]);

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    const described = new Set([...res.text.matchAll(/^# HELP (\S+)/gm)].map((match) => match[1]));
    expect(referenced).toContain('http_requests_total');
    expect(referenced.filter((name) => !described.has(name))).toEqual([]);
  });

  it('labels the RED metric with the route template, never the concrete id', async () => {
    const rawId = 'zzz-cardinality-probe-9f1c';
    await request(app.getHttpServer()).get(`/products/${rawId}`);

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    expect(res.text).toContain('route="/products/:idOrSlug"');
    expect(res.text).not.toContain(rawId);
  });

  it('records the real success status on the request counter', async () => {
    await request(app.getHttpServer()).get('/products').expect(200);

    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/products"[^}]*status_code="200"/);
  });
});
