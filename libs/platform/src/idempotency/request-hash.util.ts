import { createHash } from 'node:crypto';

/**
 * Keys sorted at every depth: without this, a retry that reorders fields would flip the request
 * hash and be rejected as a key/body mismatch.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortDeep(source[key]);
        return acc;
      }, {});
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Binding method+path+scope+body makes a key replayed with a different request detectable (→ 422)
 * instead of silently returning the first request's result. Only the hash is stored, never the raw
 * body, so the store cannot leak payloads.
 */
export function computeRequestHash(method: string, path: string, scope: string, body: unknown): string {
  return sha256Hex(`${method}|${path}|${scope}|${canonicalJson(body ?? null)}`);
}
