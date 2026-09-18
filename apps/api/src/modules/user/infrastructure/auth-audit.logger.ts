import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { getCorrelationId } from '@shared/observability';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { AuthAuditPort, AuthAuditRecord } from '../application/ports';

/** pino `context` label for the audit trail — the SIEM filters the whole trail on this one key. */
const LOG_CONTEXT = 'AuthAudit';

@Injectable()
export class AuthAuditLogger implements AuthAuditPort {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  record(entry: AuthAuditRecord): void {
    // The pino mixin already adds `requestId`; setting it here too keeps it on the line even
    // if this ever runs outside a request context.
    const payload = { ...entry, requestId: getCorrelationId(this.cls) };
    if (entry.outcome === 'failure') {
      this.logger.warn(payload, entry.event);
    } else {
      this.logger.info(payload, entry.event);
    }
    // Count the event (bounded event + outcome labels — never the userId/email/ip).
    this.metrics.recordAuthEvent(entry.event, entry.outcome);
  }
}
