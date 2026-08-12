import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Email } from '../../domain/email.vo';
import { PASSWORD_HASHER, type PasswordHasherPort } from '../ports/password-hasher.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/user-repository.port';
import { AuthTokensService, type AuthTokens } from '../services/auth-tokens.service';

export interface LoginUserInput {
  email: string;
  password: string;
}

// Identical 401 for "no such email" and "wrong password" — never reveal which.
const INVALID_CREDENTIALS = 'Invalid credentials';

// Throwaway password whose hash is verified on the unknown-email path so timing
// doesn't distinguish "no user" from "wrong password". Not a secret.
const DUMMY_PASSWORD = 'dummy-password-for-constant-time-login';

/**
 * Authenticate email/password and issue a token pair; generic 401 on failure.
 * The unknown-email branch runs a real argon2 verify against a cached dummy hash
 * so both failure paths cost the same.
 */
@Injectable()
export class LoginUserUseCase {
  private dummyHashPromise?: Promise<string>;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly authTokens: AuthTokensService,
  ) {}

  async execute(input: LoginUserInput): Promise<AuthTokens> {
    const email = Email.of(input.email).value;
    const user = await this.users.findByEmail(email);

    if (!user) {
      // Burn equivalent verify time, then fail with the same generic error.
      await this.hasher.verify(await this.getDummyHash(), input.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.hasher.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.authTokens.issuePair(user);
  }

  private getDummyHash(): Promise<string> {
    // Clear the field on a rejected hash() so the next login retries; caching a
    // rejection would 500 every unknown-email login and re-open the oracle.
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = this.hasher.hash(DUMMY_PASSWORD).catch((error: unknown) => {
        this.dummyHashPromise = undefined;
        throw error;
      });
    }
    return this.dummyHashPromise;
  }
}
