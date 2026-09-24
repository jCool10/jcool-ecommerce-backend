import type { AuthAuditPort, AuthAuditRecord } from '../application/ports';

export class RecordingAuthAudit implements AuthAuditPort {
  readonly records: AuthAuditRecord[] = [];

  record(entry: AuthAuditRecord): void {
    this.records.push(entry);
  }
}
