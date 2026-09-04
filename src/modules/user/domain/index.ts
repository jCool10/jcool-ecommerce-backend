// Barrel: User domain value objects. Import siblings by file (avoid cycles).
// `normalizeEmail` lives in `@shared/kernel` — routing (`bucketForEmail`) and uniqueness
// (`Email`) must canonicalize through one function, so both import it upward.
export * from './email.vo';
