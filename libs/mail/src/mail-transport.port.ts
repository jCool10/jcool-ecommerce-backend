export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Transport only: each context owns the wording, links and templating of its own mail. */
export interface MailTransportPort {
  sendMail(message: MailMessage): Promise<void>;
}
