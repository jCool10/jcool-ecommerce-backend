import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { redactPaths } from './redact-paths';

// Log one object through a pino instance configured with our redact paths and return the
// serialized JSON line, so the assertions run against exactly what would hit stdout.
function serialize(payload: Record<string, unknown>): string {
  let captured = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });
  const logger = pino({ redact: { paths: redactPaths, censor: '[Redacted]' } }, sink);
  logger.info(payload, 'test');
  return captured;
}

describe('redactPaths', () => {
  // A flat `*.password` wildcard matches only one level deep, so a nested credential slips
  // through unless the explicit path is listed.
  it('redacts a nested req.body.user.password (2 levels deep)', () => {
    const line = serialize({ req: { body: { user: { password: 'super-secret' } } } });
    expect(line).toContain('[Redacted]');
    expect(line).not.toContain('super-secret');
  });

  it('redacts transport credentials (authorization, cookie) and flat password fields', () => {
    const line = serialize({
      req: { headers: { authorization: 'Bearer abc.def', cookie: 'sid=xyz' } },
      user: { password: 'pw' },
    });
    expect(line).not.toContain('Bearer abc.def');
    expect(line).not.toContain('sid=xyz');
    expect(line).not.toContain('"password":"pw"');
  });

  // A `*.key` wildcard starts one level in, so a credential logged as a bare field — the shape a
  // call site reaches for first — used to go out verbatim.
  it('redacts a sensitive key at the top level', () => {
    const line = serialize({ token: 'raw-token', refreshToken: 'raw-refresh', accessToken: 'raw-access' });

    expect(line).not.toContain('raw-token');
    expect(line).not.toContain('raw-refresh');
    expect(line).not.toContain('raw-access');
    expect(line).toContain('"token":"[Redacted]"');
  });

  it('still redacts the same key one level in', () => {
    const line = serialize({ user: { token: 'nested-token' } });

    expect(line).not.toContain('nested-token');
    expect(line).toContain('[Redacted]');
  });

  // pino rejects a bare hyphenated path segment; set-cookie is covered by its explicit bracket path.
  it('derives no bare path for the hyphenated set-cookie key', () => {
    expect(redactPaths).not.toContain('set-cookie');
    expect(redactPaths).not.toContain('*.set-cookie');
    expect(redactPaths).toContain('res.headers["set-cookie"]');
  });

  it('leaves non-sensitive fields intact', () => {
    const line = serialize({ orderId: 'ord-42', route: '/orders/:id' });
    expect(line).toContain('ord-42');
    expect(line).toContain('/orders/:id');
  });
});
