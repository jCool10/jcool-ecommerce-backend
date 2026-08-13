// Names + scope for the auth cookies, in one place so the setter, readers, and e2e helpers can't drift.

/** httpOnly cookie carrying the opaque refresh token (never readable by JS). */
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/** Readable cookie holding the signed CSRF token — echoed back in CSRF_HEADER. */
export const CSRF_TOKEN_COOKIE = 'csrf_token';

/** Request header the client must send the CSRF token in (double-submit). */
export const CSRF_HEADER = 'x-csrf-token';

/** Cookie Path — scoped to /auth so the browser only attaches these cookies to the auth routes. */
export const AUTH_COOKIE_PATH = '/auth';
