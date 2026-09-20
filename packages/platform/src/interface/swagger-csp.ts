/**
 * Swagger UI bootstraps itself from an inline `<script>`, which helmet's default `script-src 'self'`
 * blocks. Relaxing that one directive keeps the rest of the default policy — `object-src 'none'`,
 * `frame-ancestors 'self'`, `base-uri 'self'` — which turning the whole policy off would have dropped
 * on every route, not just the docs.
 */
export const swaggerContentSecurityPolicy = {
  useDefaults: true,
  directives: { scriptSrc: ["'self'", "'unsafe-inline'"] },
};
