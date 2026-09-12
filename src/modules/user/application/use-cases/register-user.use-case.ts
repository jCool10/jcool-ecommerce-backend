import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@shared/kernel/to-error';
import type { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain';
import { PASSWORD_HASHER, type PasswordHasherPort, USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { EmailVerificationService } from '../services';

const LOG_CONTEXT = 'RegisterUser';

export interface RegisterUserInput {
  email: string;
  password: string;
}

@Injectable()
export class RegisterUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly emailVerification: EmailVerificationService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(input: RegisterUserInput): Promise<User> {
    const email = Email.of(input.email).value;

    // No pre-check: the unique email index is the sole guard. Hashing before the insert makes a
    // taken-email attempt cost the same as a real signup (closes a register timing oracle); the
    // argon2 cost per attempt is bounded by the register throttle.
    const passwordHash = await this.hasher.hash(input.password);
    const user = await this.users.create({ email, passwordHash });
    if (!user) {
      throw new ConflictException('Email already registered'); // lost the insert race
    }

    // Not awaited, so a slow mail server cannot stretch an already-persisted signup. The mailer
    // itself swallows delivery failures; the .catch is only what `void` needs.
    void this.emailVerification.issueAndSend(user).catch((err: unknown) => {
      this.logger.warn({ userId: user.id, err: toError(err) }, 'verification email failed');
    });
    return user;
  }
}
