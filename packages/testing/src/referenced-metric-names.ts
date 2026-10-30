import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROMQL_OPERATORS = new Set(['and', 'or', 'unless', 'offset', 'bool']);

/**
 * Every metric the alert rules and Grafana dashboards under `infraDir` query, sorted. Each service
 * filters it down to the metrics it owns and checks those are described on its `/metrics`.
 */
export function referencedMetricNames(infraDir: string): string[] {
  return metricNames([...ruleExpressions(infraDir), ...dashboardExpressions(infraDir)]);
}

function filesIn(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(extension))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
}

function ruleExpressions(infraDir: string): string[] {
  const exprs: string[] = [];
  for (const text of filesIn(join(infraDir, 'prometheus/rules'), '.yml')) {
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

function dashboardExpressions(infraDir: string): string[] {
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
  for (const text of filesIn(join(infraDir, 'grafana/provisioning/dashboards'), '.json')) walk(JSON.parse(text));
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
      if (PROMQL_OPERATORS.has(token) || token.includes(':')) continue;
      names.add(token.replace(/_(bucket|count|sum)$/, ''));
    }
  }
  return [...names].sort();
}
