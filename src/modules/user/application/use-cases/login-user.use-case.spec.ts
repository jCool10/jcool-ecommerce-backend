import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { User } from '../../domain/entities/user.entity';
import type { PasswordHasherPort } from '../ports/password-hasher.port';
import type { UserRepositoryPort } from '../ports/user-repository.port';
import type { AuthTokens, AuthTokensService } from '../services/auth-tokens.service';
import { LoginUserUseCase } from './login-user.use-case';

const TOKENS: AuthTokens = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 900 };

function makeUser(passwordHash: string, emailVerifiedAt: Date | null = null): User {
  return new User('u1', 'user@example.com', passwordHash, 'CUSTOMER', new Date(), new Date(), emailVerifiedAt);
}

// Config stub exposing only `auth.requireVerifiedEmail` (the gate flag).
function makeConfig(requireVerifiedEmail: boolean): ConfigService {
  return { get: () => requireVerifiedEmail } as unknown as ConfigService;
}

class MockUserRepository implements UserRepositoryPort {
  user: User | null = null;
  lastFindEmail?: string;

  findByEmail(email: string): Promise<User | null> {
    this.lastFindEmail = email;
    return Promise.resolve(this.user);
  }
  findById(): Promise<User | null> {
    return Promise.resolve(null);
  }
  create(): Promise<User> {
    return Promise.reject(new Error('unused'));
  }
  markEmailVerified(): Promise<void> {
    return Promise.resolve();
  }
  updatePassword(): Promise<void> {
    return Promise.resolve();
  }
}

// Counter-based mock (matches the repo's class-mock convention) — a stored hash
// is `hashed:<plain>`, so verify is an equality check.
class MockPasswordHasher implements PasswordHasherPort {
  hashCalls = 0;
  verifyCalls = 0;

  hash(plain: string): Promise<string> {
    this.hashCalls++;
    return Promise.resolve(`hashed:${plain}`);
  }
  verify(digest: string, plain: string): Promise<boolean> {
    this.verifyCalls++;
    return Promise.resolve(digest === `hashed:${plain}`);
  }
}

class MockAuthTokensService {
  issuedFor: User[] = [];
  issuePair(user: User): Promise<AuthTokens> {
    this.issuedFor.push(user);
    return Promise.resolve(TOKENS);
  }
}

describe('LoginUserUseCase', () => {
  let repo: MockUserRepository;
  let hasher: MockPasswordHasher;
  let authTokens: MockAuthTokensService;
  let useCase: LoginUserUseCase;

  beforeEach(() => {
    repo = new MockUserRepository();
    hasher = new MockPasswordHasher();
    authTokens = new MockAuthTokensService();
    // Gate off by default; the gate suite builds its own use case with it on.
    useCase = new LoginUserUseCase(repo, hasher, authTokens as unknown as AuthTokensService, makeConfig(false));
  });

  it('issues a token pair on valid credentials', async () => {
    repo.user = makeUser('hashed:correct-password');

    await expect(useCase.execute({ email: 'user@example.com', password: 'correct-password' })).resolves.toBe(TOKENS);
    expect(authTokens.issuedFor).toEqual([repo.user]);
  });

  it('normalizes the email before lookup', async () => {
    repo.user = makeUser('hashed:correct-password');

    await useCase.execute({ email: '  User@Example.COM ', password: 'correct-password' });
    expect(repo.lastFindEmail).toBe('user@example.com');
  });

  it('throws 401 on a wrong password and does not issue tokens', async () => {
    repo.user = makeUser('hashed:correct-password');

    await expect(useCase.execute({ email: 'user@example.com', password: 'wrong' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authTokens.issuedFor).toHaveLength(0);
  });

  it('throws 401 for an unknown email AND still runs a dummy verify (anti-enumeration)', async () => {
    repo.user = null;

    await expect(useCase.execute({ email: 'nobody@example.com', password: 'whatever' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // A dummy hash was produced and verified so timing matches the real path.
    expect(hasher.hashCalls).toBe(1);
    expect(hasher.verifyCalls).toBe(1);
    expect(authTokens.issuedFor).toHaveLength(0);
  });

  it('uses the SAME error message for wrong-password and unknown-email', async () => {
    repo.user = makeUser('hashed:correct-password');
    const wrongPw = await useCase.execute({ email: 'user@example.com', password: 'wrong' }).catch((e: Error) => e);

    repo.user = null;
    const unknown = await useCase.execute({ email: 'nobody@example.com', password: 'wrong' }).catch((e: Error) => e);

    expect(wrongPw).toBeInstanceOf(UnauthorizedException);
    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect((wrongPw as Error).message).toBe((unknown as Error).message);
  });

  describe('verified-email gate (auth.requireVerifiedEmail=true)', () => {
    function gatedUseCase(): LoginUserUseCase {
      return new LoginUserUseCase(repo, hasher, authTokens as unknown as AuthTokensService, makeConfig(true));
    }

    it('refuses an unverified account with 403 and issues no tokens', async () => {
      repo.user = makeUser('hashed:correct-password', null);

      await expect(
        gatedUseCase().execute({ email: 'user@example.com', password: 'correct-password' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(authTokens.issuedFor).toHaveLength(0);
    });

    it('lets a verified account through', async () => {
      repo.user = makeUser('hashed:correct-password', new Date());

      await expect(gatedUseCase().execute({ email: 'user@example.com', password: 'correct-password' })).resolves.toBe(
        TOKENS,
      );
    });

    it('still returns the generic 401 (not 403) on a wrong password', async () => {
      repo.user = makeUser('hashed:correct-password', null);

      // The gate only applies after credentials pass — a bad password must not
      // leak that the account merely needs verification.
      await expect(gatedUseCase().execute({ email: 'user@example.com', password: 'wrong' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
