export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends a message; it never composes one. Each context owns the wording, the links and the
 * templating of its own mail — this side knows only how to get bytes to a mail server.
 */
export interface MailTransportPort {
  sendMail(message: MailMessage): Promise<void>;
}
