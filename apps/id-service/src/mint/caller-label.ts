const CALLER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The header is caller-controlled, so anything but a service-like name collapses into one series. */
export function callerLabel(header: string | string[] | undefined): string {
  return typeof header === 'string' && CALLER_PATTERN.test(header) ? header : 'unknown';
}
