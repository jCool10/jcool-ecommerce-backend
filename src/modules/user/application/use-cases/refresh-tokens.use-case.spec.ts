import { Logger, UnauthorizedException } from '@nestjs/common';
import { hashRefreshToken } from '../hash-refresh-token';
import type {
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
} from '../ports/refresh-token-repository.port';
import type { AuthTokens, AuthTokensService, IssuedRefreshToken } from '../services/auth-tokens.service';
import { RefreshTokensUseCase } from './refresh-tokens.use-case';

// Fixed successor the mocked service mints — lets tests assert exactly what the
// use case passes to rotate() and returns to the client.
const SUCCESSOR: IssuedRefreshToken = {
  raw: 'new-raw-refresh-token',
  hash: 'new-token-hash',
  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
};

class MockRefreshTokenRepository implements RefreshTokenRepositoryPort {
  outcome: RotateOutcome = { status: 'invalid' };
  lastRotate?: RotateRefreshTokenInput;
  rotateCalls = 0;

  create(): Promise<void> {
    return Promise.reject(new Error('unused'));
  }
  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome> {
    this.rotateCalls++;
    this.lastRotate = input;
    return Promise.resolve(this.outcome);
  }
  revoke(): Promise<void> {
    return Promise.reject(new Error('unused'));
  }
}

class MockAuthTokensService {
  signAccessCalls: Array<{ sub: string; role: string }> = [];

  get accessExpiresIn(): number {
    return 900;
  }
  newRefreshToken(): IssuedRefreshToken {
    return SUCCESSOR;
  }
  signAccess(sub: string, role: string): Promise<string> {
    this.signAccessCalls.push({ sub, role });
    return Promise.resolve('signed-access-token');
  }
}

describe('RefreshTokensUseCase', () => {
  const PRESENTED_RAW = 'presented-raw-refresh-token';
  let repo: MockRefreshTokenRepository;
  let authTokens: MockAuthTokensService;
  let useCase: RefreshTokensUseCase;

  beforeEach(() => {
    repo = new MockRefreshTokenRepository();
    authTokens = new MockAuthTokensService();
    useCase = new RefreshTokensUseCase(repo, authTokens as unknown as AuthTokensService);
  });

  it('rotates a valid token: hashes the presented token, passes the successor, returns the new pair', async () => {
    repo.outcome = { status: 'rotated', userId: 'u1', role: 'CUSTOMER' };

    const result: AuthTokens = await useCase.execute(PRESENTED_RAW);

    // Presented token is looked up by hash (never raw); successor is handed to rotate.
    expect(repo.lastRotate).toEqual({
      presentedTokenHash: hashRefreshToken(PRESENTED_RAW),
      newTokenHash: SUCCESSOR.hash,
      newExpiresAt: SUCCESSOR.expiresAt,
    });
    // Access token signed with the *fresh* role read during rotation.
    expect(authTokens.signAccessCalls).toEqual([{ sub: 'u1', role: 'CUSTOMER' }]);
    expect(result).toEqual({
      accessToken: 'signed-access-token',
      refreshToken: SUCCESSOR.raw,
      expiresIn: 900,
    });
  });

  it('throws 401 for an invalid/expired/unknown token and signs nothing', async () => {
    repo.outcome = { status: 'invalid' };

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authTokens.signAccessCalls).toHaveLength(0);
  });

  it('reuse of a SUPERSEDED token (replaced) warns loud (theft signal) and issues no token', async () => {
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: true };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
    expect(authTokens.signAccessCalls).toHaveLength(0);

    jest.restoreAllMocks();
  });

  it('replay of a merely-revoked token (logout/killed family) logs debug, not a theft warn', async () => {
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: false };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
  });

  it('uses the same generic 401 message for invalid and reuse (no reason leaked)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    repo.outcome = { status: 'invalid' };
    const invalid = await useCase.execute(PRESENTED_RAW).catch((e: Error) => e);
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: true };
    const reuse = await useCase.execute(PRESENTED_RAW).catch((e: Error) => e);

    expect((invalid as Error).message).toBe((reuse as Error).message);
    jest.restoreAllMocks();
  });
});
