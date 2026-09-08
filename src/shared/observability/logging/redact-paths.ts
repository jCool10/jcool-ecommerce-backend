import { SENSITIVE_KEYS } from './sensitive-keys';

// Derived from SENSITIVE_KEYS so the logger and the Sentry scrub can't disagree on what is
// sensitive. Skips the hyphenated `set-cookie`: a `*` wildcard can't express it, so it is listed
// explicitly below instead.
const wildcardPaths: string[] = SENSITIVE_KEYS.filter((key) => !key.includes('-')).map((key) => `*.${key}`);

/**
 * Redacted at the logger layer so protection doesn't depend on every call site remembering to omit
 * them. The explicit paths exist because pino wildcards match a SINGLE level only. Email/PII is left
 * intact on purpose: the auth audit trail records it, and the external Sentry sink scrubs it there.
 */
export const redactPaths: string[] = [
  ...wildcardPaths,
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.user.password',
];
