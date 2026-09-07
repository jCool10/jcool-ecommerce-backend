/**
 * Canonical sensitive key names — the single source of truth for "what is a secret/credential",
 * shared by pino log redaction (redact-paths.ts) and the Sentry PII scrub (error-tracking/scrub-pii.ts)
 * so the two can't drift on what to protect. Stored in their real casing for pino's case-sensitive
 * path matching; {@link isSensitiveKey} matches case-insensitively for the Sentry object walk.
 * Email/PII is deliberately absent: the audit trail keeps it in logs (ADR-0013); the external Sentry
 * sink strips email separately (ADR-0016), so adding it here would over-redact the logs.
 */
export const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  // A link is as redeemable as the token inside it, and neither key name contains "token".
  'verifyUrl',
  'resetUrl',
  'refreshToken',
  'accessToken',
  'authorization',
  'cookie',
  'set-cookie',
] as const;

const SENSITIVE_KEY_SET = new Set<string>(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

/** True when `key` (any case) names a sensitive credential in {@link SENSITIVE_KEYS}. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(key.toLowerCase());
}
