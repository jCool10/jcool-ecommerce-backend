import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain';
import { PASSWORD_HASHER, type PasswordHasherPort, USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { EmailVerificationService } from '../services';

export interface RegisterUserInput {
  email: string;
  password: string;
}

/** Register a new CUSTOMER — 409 on a taken email (the DB unique index is the real guard), else hash (argon2id), persist as unverified, and send a verification token. */
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

    // No pre-check: the unique email index is the sole guard. Hashing before the
    // insert makes a taken-email attempt cost the same as a real signup (closes a
    // register timing oracle); the argon2 cost per attempt is bounded by the
    // register throttle.
    const passwordHash = await this.hasher.hash(input.password);
    // `role` omitted → DB default CUSTOMER; new accounts are unverified until the emailed token is redeemed.
    const user = await this.users.create({ email, passwordHash });
    if (!user) {
      throw new ConflictException('Email already registered'); // lost the insert race
    }

    // After the row commits, non-fatal: a slow/throwing mailer must not 500 an
    // already-persisted signup. Explicit .catch keeps it off the unhandledRejection
    // path; the user can re-trigger via resend-verification. (Phase 2: outbox.)
    void this.emailVerification.issueAndSend(user).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Verification email failed for user ${user.id}: ${reason}`);
    });
    return user;
  }
}
