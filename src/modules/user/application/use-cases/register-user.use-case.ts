import { ConflictException, Inject, Injectable } from '@nestjs/common';
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
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  async execute(input: RegisterUserInput): Promise<User> {
    const email = Email.of(input.email).value;

    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.hasher.hash(input.password);
    // `role` omitted → DB default CUSTOMER; new accounts are unverified until the emailed token is redeemed.
    const user = await this.users.create({ email, passwordHash });
    await this.emailVerification.issueAndSend(user);
    return user;
  }
}
