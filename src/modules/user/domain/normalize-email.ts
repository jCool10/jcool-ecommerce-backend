/** Canonicalize an email (trim + lowercase); register and login must share this because the `users.email` unique index is case-sensitive (provider dot/plus folding is out of scope). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
