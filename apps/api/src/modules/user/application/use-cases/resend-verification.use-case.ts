import { Inject, Injectable } from '@nestjs/common';
import { Email } from '../../domain';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { EmailVerificationService } from '../services';

/** Enumeration-safe: the unknown-or-verified branch is a silent no-op, so every caller gets one generic response. */
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
