export const MAILER = Symbol('MAILER');

export interface EmailVerificationMessage {
  to: string;
  /** Raw (unhashed) token to embed in the verification link. */
  token: string;
}

export interface PasswordResetMessage {
  to: string;
  /** Raw (unhashed) token to embed in the reset link. */
  token: string;
}

/** Outbound transactional email; the adapter owns transport and templating. Neither method rejects on a delivery failure — see MailerAdapter for why. */
export interface MailerPort {
  sendEmailVerification(message: EmailVerificationMessage): Promise<void>;
  sendPasswordReset(message: PasswordResetMessage): Promise<void>;
}
