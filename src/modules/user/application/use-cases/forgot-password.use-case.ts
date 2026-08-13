import { Inject, Injectable } from '@nestjs/common';
import { Email } from '../../domain';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { PasswordResetService } from '../services';

/** Start the "forgot password" flow, enumeration-safe (always the same generic response); a reset token is issued only for an existing account, independent of email verification. */
@Injectable()
export class ForgotPasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly passwordReset: PasswordResetService,
  ) {}

  async execute(rawEmail: string): Promise<void> {
    const email = Email.of(rawEmail).value;
    const user = await this.users.findByEmail(email);
    if (user) {
      await this.passwordReset.issueAndSend(user);
    }
  }
}
