import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@shared/testing/fake-metrics-port';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import type { AuthAuditRecord } from '../application/ports';
import { AuthAuditLogger } from './auth-audit.logger';

function build(requestId: string | undefined) {
  const info = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
  const warn = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
  const logger = fakePinoLogger({ info, warn });
  const cls = {
    isActive: () => requestId !== undefined,
    getId: () => requestId,
  } as unknown as ClsService;
  const recordAuthEvent = vi.fn<(event: string, outcome: 'success' | 'failure') => void>();
  const metrics = fakeMetricsPort({ recordAuthEvent });
  return { logger: new AuthAuditLogger(logger, cls, metrics), info, warn, recordAuthEvent };
}

describe('AuthAuditLogger', () => {
  it('emits a success event at info level with its fields + the correlation requestId', () => {
    const { logger, info, warn } = build('req-123');
    const entry: AuthAuditRecord = {
      event: 'login.succeeded',
      outcome: 'success',
      email: 'user@test.local',
      ip: '203.0.113.7',
    };

    logger.record(entry);

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const [payload, message] = info.mock.calls[0];
    expect(message).toBe('login.succeeded');
    expect(payload).toMatchObject({ ...entry, requestId: 'req-123' });
  });

  it('increments the auth-events metric with the bounded event + outcome (never PII)', () => {
    const { logger, recordAuthEvent } = build('req-123');

    logger.record({ event: 'login.succeeded', outcome: 'success', email: 'user@test.local' });

    expect(recordAuthEvent).toHaveBeenCalledTimes(1);
    expect(recordAuthEvent).toHaveBeenCalledWith('login.succeeded', 'success');
  });

  it('routes failures to warn so a SIEM can alert on them, preserving metadata', () => {
    const { logger, info, warn } = build('req-123');

    logger.record({
      event: 'token.reuse_detected',
      outcome: 'failure',
      userId: 'u1',
      metadata: { familyId: 'fam1' },
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0];
    expect(message).toBe('token.reuse_detected');
    expect(payload).toMatchObject({ userId: 'u1', metadata: { familyId: 'fam1' }, requestId: 'req-123' });
  });

  it('omits requestId when recorded outside a request context', () => {
    const { logger, info } = build(undefined);

    logger.record({ event: 'user.registered', outcome: 'success', userId: 'u2' });

    const [payload] = info.mock.calls[0];
    expect(payload.requestId).toBeUndefined();
  });

  it('never leaks a password field even if callers misuse the record', () => {
    const { logger, warn } = build('req-123');

    logger.record({ event: 'login.failed', outcome: 'failure', email: 'user@test.local' });

    const [payload] = warn.mock.calls[0];
    expect(JSON.stringify(payload)).not.toContain('password');
  });
});
