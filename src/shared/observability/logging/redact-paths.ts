import { SENSITIVE_KEYS } from './sensitive-keys';

// Sensitive keys usable as bare pino paths, derived from the shared SENSITIVE_KEYS list so the
// logger and the Sentry scrub can't disagree on what is sensitive. Skips the hyphenated
// `set-cookie`: pino rejects a bare hyphenated segment, and a `*` wildcard can't express it either
// (its explicit bracket path below covers it).
const plainKeys: string[] = SENSITIVE_KEYS.filter((key) => !key.includes('-'));

// Top level: `logger.info({ token })` — a `*.key` wildcard starts one level in, so without these
// a credential logged as a bare field goes out verbatim.
const topLevelPaths: string[] = plainKeys;

// One level in, for ad-hoc objects: `logger.info({ user: { token } })`.
const wildcardPaths: string[] = plainKeys.map((key) => `*.${key}`);

/**
 * Secret/credential paths scrubbed at the logger layer (pino `redact`), so protection doesn't
 * depend on every call site remembering to omit them. The explicit paths below cover cases the
 * one-level `*.key` catch-alls miss (pino wildcards match a single level only) — the nested
 * `req.body.user.password` and the transport headers. Email/PII is left intact on purpose (the auth
 * audit trail records it; the external Sentry sink scrubs it separately — ADR-0016). See ADR-0013.
 */
export const redactPaths: string[] = [
  ...topLevelPaths,
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
