/**
 * Secret/credential paths scrubbed at the LOGGER layer (pino `redact`), so protection
 * does not depend on every call site remembering to omit them (ADR-0013). The list
 * includes a genuinely nested path — `req.body.user.password` (2 levels) — which a flat
 * `*.password` wildcard would NOT catch; the redaction spec proves exactly that (DoD-2).
 *
 * PII such as email is intentionally NOT redacted here: the auth audit trail records it
 * on purpose. Masking (vs removal) of email is deferred (see plan's open questions).
 */
export const redactPaths: string[] = [
  // Transport-level credentials.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Request-body credentials — flat, plus the nested case that motivates the DoD-2 test.
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.user.password',
  // Catch-alls one level deep, for ad-hoc objects logged anywhere.
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
];
