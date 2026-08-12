import { hashRefreshToken } from '../hash-refresh-token';
import type { RefreshTokenRepositoryPort, RotateOutcome } from '../ports/refresh-token-repository.port';
import { LogoutUserUseCase } from './logout-user.use-case';

class MockRefreshTokenRepository implements RefreshTokenRepositoryPort {
  revokeCalls: Array<{ userId: string; tokenHash: string }> = [];

  create(): Promise<void> {
    return Promise.reject(new Error('unused'));
  }
  rotate(): Promise<RotateOutcome> {
    return Promise.reject(new Error('unused'));
  }
  revoke(userId: string, tokenHash: string): Promise<void> {
    this.revokeCalls.push({ userId, tokenHash });
    return Promise.resolve();
  }
}

describe('LogoutUserUseCase', () => {
  const RAW = 'raw-refresh-token';
  let repo: MockRefreshTokenRepository;
  let useCase: LogoutUserUseCase;

  beforeEach(() => {
    repo = new MockRefreshTokenRepository();
    useCase = new LogoutUserUseCase(repo);
  });

  it('revokes by (userId, hash-of-presented-token) — scoped to the caller, never raw', async () => {
    await useCase.execute('u1', RAW);

    expect(repo.revokeCalls).toEqual([{ userId: 'u1', tokenHash: hashRefreshToken(RAW) }]);
    expect(repo.revokeCalls[0].tokenHash).not.toBe(RAW);
  });

  it('resolves void (idempotent — the repo no-ops unknown/foreign/revoked tokens)', async () => {
    await expect(useCase.execute('u1', RAW)).resolves.toBeUndefined();
  });
});
