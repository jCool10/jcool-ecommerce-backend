import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referencedMetricNames } from './referenced-metric-names';

const ALERT_RULES = `groups:
  - name: http
    rules:
      - alert: HighErrorRate
        expr: sum by (route) (rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05
      - record: job:http_requests:rate5m
        expr: sum(rate(http_requests_total[5m]))
      - alert: SlowRequests
        expr: |
          histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 1
            and on (instance) up == 1
      - alert: BreakerOpen
        expr: circuit_breaker_state >= bool 2 unless job:http_requests:rate5m offset 5m or label_replace(queue_depth, "dst", "$1", "src", "(.*)")
`;

const DASHBOARD = {
  panels: [
    { targets: [{ expr: 'sum(rate(orders_created_total[5m]))' }, { expr: 'vector(1)' }] },
    {
      panels: [
        {
          targets: [
            { expr: 'rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])' },
          ],
        },
      ],
    },
  ],
  templating: { list: [{ query: 'label_values(templated_metric, route)' }] },
};

describe('referencedMetricNames', () => {
  let infraDir: string;

  beforeAll(() => {
    infraDir = mkdtempSync(join(tmpdir(), 'referenced-metric-names-'));
    const rules = join(infraDir, 'prometheus/rules');
    const dashboards = join(infraDir, 'grafana/provisioning/dashboards');
    mkdirSync(rules, { recursive: true });
    mkdirSync(dashboards, { recursive: true });
    writeFileSync(join(rules, 'http.yml'), ALERT_RULES);
    writeFileSync(join(rules, 'notes.txt'), 'expr: not_a_rule_file\n');
    writeFileSync(join(dashboards, 'orders.json'), JSON.stringify(DASHBOARD));
  });

  afterAll(() => rmSync(infraDir, { recursive: true, force: true }));

  it('lists the metrics every rule and dashboard expression queries, sorted and folded onto base names', () => {
    expect(referencedMetricNames(infraDir)).toEqual([
      'circuit_breaker_state',
      'http_request_duration_seconds',
      'http_requests_total',
      'orders_created_total',
      'queue_depth',
      'up',
    ]);
  });
});
