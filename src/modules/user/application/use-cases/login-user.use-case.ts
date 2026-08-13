import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Email } from '../../domain';
import { PASSWORD_HASHER, type PasswordHasherPort, USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { type AuthTokens, AuthTokensService } from '../services';

export interface LoginUserInput {
  email: string;
  password: string;
}

// Identical 401 for "no such email" and "wrong password" — never reveal which.
const INVALID_CREDENTIALS = 'Invalid credentials';

// Throwaway password whose hash is verified on the unknown-email path so timing
// doesn't distinguish "no user" from "wrong password". Not a secret.
const DUMMY_PASSWORD = 'dummy-password-for-constant-time-login';

/** Authenticate email/password and issue a token pair — generic 401 on failure (constant-time via a real argon2 verify against a dummy hash on the unknown-email branch), 403 when `auth.requireVerifiedEmail` blocks an unverified address. See docs/engineering-notes.md (Auth — Login, register, logout, profile). */
@Injectable()
export class LoginUserUseCase {
  private dummyHashPromise?: Promise<string>;
  private readonly requireVerifiedEmail: boolean;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly authTokens: AuthTokensService,
    config: ConfigService,
  ) {
    this.requireVerifiedEmail = config.get<boolean>('auth.requireVerifiedEmail') ?? false;
  }

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

    if (this.requireVerifiedEmail && !user.isEmailVerified) {
      throw new ForbiddenException('Email not verified');
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
