import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { getCorrelationId } from '@shared/observability';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { AuthAuditPort, AuthAuditRecord } from '../application/ports';

// pino `context` label for the audit trail (SIEM filter key). Passed per-call rather than
// via setContext() because the base PinoLogger is a shared singleton.
const AUTH_AUDIT_CONTEXT = 'AuthAudit';

// Structured-log sink for the auth audit trail: one pino line per event under the
// dedicated `AuthAudit` context (SIEM-filterable), stamped with the request correlation
// id. Failures log at `warn` (alertable), the rest at `info`. The AuthAuditPort contract
// is unchanged — only the emission mechanism (was NestJS Logger + JSON.stringify). ADR-0013.
@Injectable()
export class AuthAuditLogger implements AuthAuditPort {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  record(entry: AuthAuditRecord): void {
    // Audit fields become top-level, queryable log fields (not a JSON string). pino adds
    // `time`; the mixin adds `requestId`, but we set it explicitly too so it survives even
    // if this ever runs outside a request context.
    const payload = { context: AUTH_AUDIT_CONTEXT, ...entry, requestId: getCorrelationId(this.cls) };
    if (entry.outcome === 'failure') {
      this.logger.warn(payload, entry.event);
    } else {
      this.logger.info(payload, entry.event);
    }
    // Count the event (bounded event + outcome labels — never the userId/email/ip).
    this.metrics.recordAuthEvent(entry.event, entry.outcome);
  }
}
