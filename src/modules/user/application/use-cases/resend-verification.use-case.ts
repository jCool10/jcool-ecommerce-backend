import { Inject, Injectable } from '@nestjs/common';
import { Email } from '../../domain/email.vo';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/user-repository.port';
import { EmailVerificationService } from '../services/email-verification.service';

/**
 * Resend the email-verification message — enumeration-safe (always the same generic
 * response); a token is issued only for an existing, still-unverified account.
 */
@Injectable()
export class ResendVerificationUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  async execute(rawEmail: string): Promise<void> {
    const email = Email.of(rawEmail).value;
    const user = await this.users.findByEmail(email);
    if (user && !user.isEmailVerified) {
      await this.emailVerification.issueAndSend(user);
    }
  }
}
