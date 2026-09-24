import type { EmailVerificationMessage, MailerPort, PasswordResetMessage } from '../application/ports';

export class RecordingMailer implements MailerPort {
  readonly verifications: EmailVerificationMessage[] = [];
  readonly resets: PasswordResetMessage[] = [];

  sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    this.verifications.push(message);
    return Promise.resolve();
  }

  sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    this.resets.push(message);
    return Promise.resolve();
  }
}
