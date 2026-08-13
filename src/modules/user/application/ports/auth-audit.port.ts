// Structured, side-band audit trail for security-relevant auth events. Recording
// never alters the auth outcome and never throws back into the caller.

export const AUTH_AUDIT = Symbol('AUTH_AUDIT');

export type AuthAuditEvent =
  | 'login.succeeded'
  | 'login.failed'
  | 'logout'
  | 'logout.all'
  | 'token.refreshed'
  | 'token.reuse_detected'
  | 'user.registered'
  | 'email.verification_sent'
  | 'email.verified'
  | 'password.reset_requested'
  | 'password.reset'
  | 'password.changed'
  | 'session.revoked'
  | 'role.changed'; // wired for a future admin role endpoint; nothing emits it yet

/** Request-derived context; optional because server-side events (reuse) lack it. */
export interface AuthAuditContext {
  ip?: string;
  userAgent?: string;
}

export interface AuthAuditRecord extends AuthAuditContext {
  event: AuthAuditEvent;
  outcome: 'success' | 'failure';
  /** Account subject when known (logout, register, reuse); absent pre-auth. */
  userId?: string;
  /** Account identifier for credential events (login) where userId isn't resolved. */
  email?: string;
  /** Machine-readable cause for failures/notable events (e.g. 'invalid_credentials'). */
  reason?: string;
  /** Event-specific extras (e.g. the refresh token familyId on a reuse). */
  metadata?: Record<string, string | number | boolean>;
}

export interface AuthAuditPort {
  record(entry: AuthAuditRecord): void;
}
