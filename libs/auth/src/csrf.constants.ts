/**
 * Edge configuration, not user-domain code: the app's CORS setup has to allow this header, and an
 * app that only verifies tokens still needs the name without importing the issuer's interface layer.
 */
export const CSRF_HEADER = 'x-csrf-token';
