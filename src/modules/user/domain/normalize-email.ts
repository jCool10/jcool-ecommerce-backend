/**
 * Canonicalize an email (trim + lowercase). Register and login must normalize
 * through the same function — the `users.email` unique index is case-sensitive,
 * so skipping it would allow duplicate accounts or failed logins. Provider rules
 * (Gmail dot/plus folding) are intentionally out of scope.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
