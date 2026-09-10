import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain';
import { PASSWORD_HASHER, type PasswordHasherPort, USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { EmailVerificationService } from '../services';

export interface RegisterUserInput {
  email: string;
  password: string;
}

@Injectable()
export class RegisterUserUseCase {
  private readonly logger = new Logger(RegisterUserUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly emailVerification: EmailVerificationService,
  ) {}

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
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Verification email failed for user ${user.id}: ${reason}`);
    });
    return user;
  }
}
