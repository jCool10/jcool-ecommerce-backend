import { Injectable, Logger } from '@nestjs/common';
import type { AuthAuditPort, AuthAuditRecord } from '../application/ports';

// Structured-log sink for the auth audit trail: one JSON line per event under the
// dedicated `AuthAudit` context (SIEM-filterable); failures log at `warn`, the rest at `log`.
@Injectable()
export class AuthAuditLogger implements AuthAuditPort {
  private readonly logger = new Logger('AuthAudit');

  record(entry: AuthAuditRecord): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    if (entry.outcome === 'failure') {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
  }
}
