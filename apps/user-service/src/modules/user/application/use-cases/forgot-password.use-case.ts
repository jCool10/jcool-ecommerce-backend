import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { Email } from '../../domain';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { PasswordResetService } from '../services';

const LOG_CONTEXT = 'ForgotPasswordUseCase';

/** Enumeration-safe: the unknown-address branch is a silent no-op, so every caller gets one generic response. */
@Injectable()
export class ForgotPasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly passwordReset: PasswordResetService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(rawEmail: string): Promise<void> {
    const email = Email.of(rawEmail).value;
    const user = await this.users.findByEmail(email);
    // Not awaited: issuing mints an id over the network, and only a known address pays for it, in
    // latency or in a 503.
    if (user) {
      void this.passwordReset
        .issueAndSend(user)
        .catch((err: unknown) => this.logger.warn({ userId: user.id, err: toError(err) }, 'password reset not issued'));
    }
  }
}
