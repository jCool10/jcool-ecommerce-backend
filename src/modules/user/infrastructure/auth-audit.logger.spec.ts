import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthAuditRecord } from '../application/ports/auth-audit.port';
import { AuthAuditLogger } from './auth-audit.logger';

// Capture whatever the audit logger emits, per level, and parse the JSON payload.
function capture() {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return { log, warn };
}

describe('AuthAuditLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits a success event as a structured JSON line at log level', () => {
    const { log, warn } = capture();
    const entry: AuthAuditRecord = {
      event: 'login.succeeded',
      outcome: 'success',
      email: 'user@test.local',
      ip: '203.0.113.7',
    };

    new AuthAuditLogger().record(entry);

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0][0] as string) as AuthAuditRecord & { ts: string };
    expect(payload).toMatchObject(entry);
    // Own ISO timestamp so aggregation doesn't depend on the logger's own clock line.
    expect(typeof payload.ts).toBe('string');
    expect(Number.isNaN(Date.parse(payload.ts))).toBe(false);
  });

  it('routes failures to warn so a SIEM can alert on them', () => {
    const { log, warn } = capture();

    new AuthAuditLogger().record({
      event: 'token.reuse_detected',
      outcome: 'failure',
      userId: 'u1',
      metadata: { familyId: 'fam1' },
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warn.mock.calls[0][0] as string) as AuthAuditRecord & { ts: string };
    expect(payload.event).toBe('token.reuse_detected');
    expect(payload.metadata).toEqual({ familyId: 'fam1' });
  });

  it('never leaks a password field even if callers misuse metadata', () => {
    const { warn } = capture();

    new AuthAuditLogger().record({ event: 'login.failed', outcome: 'failure', email: 'user@test.local' });

    const line = warn.mock.calls[0][0] as string;
    expect(line).not.toContain('password');
  });
});
