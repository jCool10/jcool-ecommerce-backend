/**
 * Secret/credential paths scrubbed at the logger layer (pino `redact`), so protection doesn't
 * depend on every call site remembering to omit them. Includes a nested path
 * (`req.body.user.password`) that a flat `*.password` wildcard would miss. Email/PII is left
 * intact on purpose (the auth audit trail records it). See ADR-0013.
 */
export const redactPaths: string[] = [
  // Transport-level credentials.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Request-body credentials — flat, plus the nested case a wildcard would miss.
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
