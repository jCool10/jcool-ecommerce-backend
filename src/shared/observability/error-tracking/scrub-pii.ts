import type { ErrorEvent, EventHint } from '@sentry/nestjs';
import { isSensitiveKey } from '../logging/sensitive-keys';

const REDACTED = '[Redacted]';
// Sentry events are shallow; a depth bound stops a pathological or cyclic payload from spinning.
const MAX_DEPTH = 6;

function scrubDeep(value: unknown, depth: number): void {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) scrubDeep(item, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isSensitiveKey(key)) {
      record[key] = REDACTED;
    } else {
      scrubDeep(record[key], depth + 1);
    }
  }
}

/**
 * Sentry `beforeSend` hook. The external error sink must not receive the PII that the internal
 * audit log deliberately keeps — hence the customer email is dropped here but not from logs.
 */
export function scrubPii(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) {
    scrubDeep(event.request.data, 0);
    scrubDeep(event.request.headers, 0);
    scrubDeep(event.request.cookies, 0);
    // query_string / url are raw strings scrubDeep can't reach; drop the query entirely so a future
    // `?token=…` style param can't ship a credential to the external sink (none exist today).
    delete event.request.query_string;
    if (typeof event.request.url === 'string') {
      event.request.url = event.request.url.split('?')[0];
    }
  }
  scrubDeep(event.extra, 0);
  if (event.user && 'email' in event.user) {
    delete event.user.email;
  }
  return event;
}
