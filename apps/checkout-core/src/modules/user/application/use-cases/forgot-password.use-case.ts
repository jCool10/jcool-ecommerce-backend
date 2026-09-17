import { Inject, Injectable } from '@nestjs/common';
import { Email } from '../../domain';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { PasswordResetService } from '../services';

/** Enumeration-safe: the unknown-address branch is a silent no-op, so every caller gets one generic response. */
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
