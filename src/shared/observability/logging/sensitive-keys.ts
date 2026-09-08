/**
 * Single source of truth shared by pino redaction and the Sentry PII scrub so the two can't drift.
 * Stored in real casing because pino path matching is case-sensitive. Email/PII is deliberately
 * absent — the audit trail keeps it in logs, and Sentry strips email separately.
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

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(key.toLowerCase());
}
