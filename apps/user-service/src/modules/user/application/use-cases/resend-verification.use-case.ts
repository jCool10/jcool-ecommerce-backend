import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { Email } from '../../domain';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { EmailVerificationService } from '../services';

const LOG_CONTEXT = 'ResendVerificationUseCase';

/** Enumeration-safe: the unknown-or-verified branch is a silent no-op, so every caller gets one generic response. */
@Injectable()
export class ResendVerificationUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly emailVerification: EmailVerificationService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(rawEmail: string): Promise<void> {
    const email = Email.of(rawEmail).value;
    const user = await this.users.findByEmail(email);
    // Not awaited, as in ForgotPasswordUseCase.
    if (user && !user.isEmailVerified) {
      void this.emailVerification
        .issueAndSend(user)
        .catch((err: unknown) =>
          this.logger.warn({ userId: user.id, err: toError(err) }, 'verification not re-issued'),
        );
    }
  }
}
