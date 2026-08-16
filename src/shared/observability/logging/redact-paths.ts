import { SENSITIVE_KEYS } from './sensitive-keys';

// One-level `*.key` catch-alls for ad-hoc objects, derived from the shared SENSITIVE_KEYS list so
// the logger and the Sentry scrub can't disagree on what is sensitive. Skips the hyphenated
// `set-cookie` (covered by its explicit transport path — a `*` wildcard can't express it).
const wildcardPaths: string[] = SENSITIVE_KEYS.filter((key) => !key.includes('-')).map((key) => `*.${key}`);

/**
 * Secret/credential paths scrubbed at the logger layer (pino `redact`), so protection doesn't
 * depend on every call site remembering to omit them. The explicit paths below cover cases the
 * one-level `*.key` catch-alls miss (pino wildcards match a single level only) — the nested
 * `req.body.user.password` and the transport headers. Email/PII is left intact on purpose (the auth
 * audit trail records it; the external Sentry sink scrubs it separately — ADR-0016). See ADR-0013.
 */
export const redactPaths: string[] = [
  ...wildcardPaths,
  // Transport-level credentials (full paths — a one-level `*` can't reach req.headers.*).
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Request-body credentials — flat, plus the nested case a wildcard would miss.
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.user.password',
];
