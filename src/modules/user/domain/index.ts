// Import siblings by file (avoid cycles).
// `normalizeEmail` lives in `@shared/kernel`: routing and uniqueness must canonicalize identically.
export * from './email.vo';
