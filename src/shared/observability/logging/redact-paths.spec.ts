import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { redactPaths } from './redact-paths';

// Through a real pino instance, so assertions run against exactly what would hit stdout.
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
  // `*.password` matches one level only, so a nested credential slips through unless the explicit
  // path is listed.
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

  it('leaves non-sensitive fields intact', () => {
    const line = serialize({ orderId: 'ord-42', route: '/orders/:id' });
    expect(line).toContain('ord-42');
    expect(line).toContain('/orders/:id');
  });
});
