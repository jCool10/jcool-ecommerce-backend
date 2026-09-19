// Side-band trail: recording never alters the auth outcome and never throws back into the caller.

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
  /** Absent pre-auth. */
  userId?: string;
  /** Carries the account for credential events (login) where userId isn't resolved. */
  email?: string;
  /** Machine-readable cause, not free text (e.g. 'invalid_credentials'). */
  reason?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AuthAuditPort {
  record(entry: AuthAuditRecord): void;
}
