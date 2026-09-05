declare const normalizedEmailBrand: unique symbol;

/** Only `normalizeEmail` produces this brand, so deriving a routing bucket from a raw string is a type error rather than a silent divergence from the bytes behind `UNIQUE(users.email)`. */
export type NormalizedEmail = string & { readonly [normalizedEmailBrand]: true };

/** Canonicalize an email (trim + lowercase); register, login and bucket routing must share this because the `users.email` unique index is case-sensitive (provider dot/plus folding is out of scope). */
export function normalizeEmail(raw: string): NormalizedEmail {
  return raw.trim().toLowerCase() as NormalizedEmail;
}
