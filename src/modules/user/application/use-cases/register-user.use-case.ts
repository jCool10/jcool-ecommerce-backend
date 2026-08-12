import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/email.vo';
import { PASSWORD_HASHER, type PasswordHasherPort } from '../ports/password-hasher.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/user-repository.port';

export interface RegisterUserInput {
  email: string;
  password: string;
}

/**
 * Register a new CUSTOMER: 409 on a taken email, else hash (argon2id) and persist.
 * No auto-login. The DB unique index is the real guard; the pre-check just gives
 * a clean 409 for the common non-concurrent case.
 */
@Injectable()
export class RegisterUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
  ) {}

  async execute(input: RegisterUserInput): Promise<User> {
    const email = Email.of(input.email).value;

    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.hasher.hash(input.password);
    // `role` omitted → DB default CUSTOMER applies.
    return this.users.create({ email, passwordHash });
  }
}
