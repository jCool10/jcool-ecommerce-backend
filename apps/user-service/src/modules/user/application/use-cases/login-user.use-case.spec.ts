import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { User } from '../../domain/entities/user.entity';
import { EchoAccessTokenSigner, claimsOf } from '../../testing/access-token-signer.double';
import { PlainPasswordHasher } from '../../testing/plain-password-hasher.double';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { FakeUserRepository } from '../../testing/user-repository.double';
import { AuthTokensService } from '../services';
import { LoginUserUseCase } from './login-user.use-case';

function makeUser(emailVerifiedAt: Date | null = null): User {
  return new User(
    'u1',
    'user@example.com',
    'hashed:correct-password',
    'CUSTOMER',
    new Date(),
    new Date(),
    emailVerifiedAt,
  );
}

describe('LoginUserUseCase', () => {
  let users: FakeUserRepository;
  let hasher: PlainPasswordHasher;
  let refreshTokens: FakeRefreshTokenRepository;

  const loginUseCase = (requireVerifiedEmail: boolean): LoginUserUseCase =>
    new LoginUserUseCase(
      users,
      hasher,
      new AuthTokensService(
        new EchoAccessTokenSigner(),
        fakeConfigService({ 'auth.refreshTokenTtl': '7d' }),
        refreshTokens,
      ),
      fakeConfigService({ 'auth.requireVerifiedEmail': requireVerifiedEmail }),
    );
  const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => 'resolved',
      (error: unknown) => error,
    );

  beforeEach(() => {
    users = new FakeUserRepository();
    hasher = new PlainPasswordHasher();
    refreshTokens = new FakeRefreshTokenRepository();
  });

  it('issues a token pair for valid credentials under the normalized address', async () => {
    users.user = makeUser();

    const tokens = await loginUseCase(false).execute({ email: '  User@Example.COM ', password: 'correct-password' });

    expect(users.lastFindEmail).toBe('user@example.com');
    expect(claimsOf(tokens.accessToken).sub).toBe('u1');
    expect(refreshTokens.created.map((token) => token.userId)).toEqual(['u1']);
  });

  it('throws 401 on a wrong password and issues no tokens', async () => {
    users.user = makeUser();

    await expect(loginUseCase(false).execute({ email: 'user@example.com', password: 'wrong' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(refreshTokens.created).toHaveLength(0);
  });

  // Timing parity: an unknown address must cost the same argon2 verify as a wrong password.
  it('runs a password verify for an unknown email before its 401', async () => {
    await expect(
      loginUseCase(false).execute({ email: 'nobody@example.com', password: 'whatever' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect({ hashCalls: hasher.hashCalls, verifyCalls: hasher.verifyCalls }).toEqual({ hashCalls: 1, verifyCalls: 1 });
    expect(refreshTokens.created).toHaveLength(0);
  });

  it('answers a wrong password and an unknown email with the same 401 message', async () => {
    const useCase = loginUseCase(false);
    users.user = makeUser();
    const wrongPassword = await failureOf(useCase.execute({ email: 'user@example.com', password: 'wrong' }));
    users.user = null;
    const unknownEmail = await failureOf(useCase.execute({ email: 'nobody@example.com', password: 'wrong' }));

    expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
    expect(unknownEmail).toBeInstanceOf(UnauthorizedException);
    expect((wrongPassword as Error).message).toBe((unknownEmail as Error).message);
  });

  describe('with the verified-email gate on', () => {
    it('refuses an unverified account with 403 and issues no tokens', async () => {
      users.user = makeUser(null);

      await expect(
        loginUseCase(true).execute({ email: 'user@example.com', password: 'correct-password' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(refreshTokens.created).toHaveLength(0);
    });

    // The gate applies only after the credentials pass, so a bad password never reveals the account.
    it('still answers a wrong password with the generic 401', async () => {
      users.user = makeUser(null);

      await expect(loginUseCase(true).execute({ email: 'user@example.com', password: 'wrong' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
