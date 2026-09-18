import { hashRefreshToken } from '..';
import type { ActiveSession, RefreshTokenRepositoryPort, RotateOutcome, TokenDenylistPort } from '../ports';
import { LogoutUserUseCase } from './logout-user.use-case';

class MockRefreshTokenRepository implements RefreshTokenRepositoryPort {
  revokeCalls: Array<{ userId: string; tokenHash: string }> = [];

  // Retention is not this use case's concern; SweepAuthTokensService owns and tests it.
  deleteCollectable(): Promise<number> {
    return Promise.resolve(0);
  }

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
  revokeAllForUser(): Promise<void> {
    return Promise.reject(new Error('unused'));
  }
  listActiveSessions(): Promise<ActiveSession[]> {
    return Promise.reject(new Error('unused'));
  }
  revokeFamily(): Promise<boolean> {
    return Promise.reject(new Error('unused'));
  }
}

class MockDenylist implements TokenDenylistPort {
  denyCalls: Array<{ jti: string; expiresAt: Date }> = [];

  denylist(jti: string, expiresAt: Date): Promise<void> {
    this.denyCalls.push({ jti, expiresAt });
    return Promise.resolve();
  }
  isDenylisted(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe('LogoutUserUseCase', () => {
  const RAW = 'raw-refresh-token';
  const EXP = 1_700_000_000; // epoch seconds
  let repo: MockRefreshTokenRepository;
  let denylist: MockDenylist;
  let useCase: LogoutUserUseCase;

  beforeEach(() => {
    repo = new MockRefreshTokenRepository();
    denylist = new MockDenylist();
    useCase = new LogoutUserUseCase(repo, denylist);
  });

  it('revokes the refresh token by (userId, hash-of-presented-token) — scoped, never raw', async () => {
    await useCase.execute({ userId: 'u1', accessJti: 'j1', accessExp: EXP, rawRefreshToken: RAW });

    expect(repo.revokeCalls).toEqual([{ userId: 'u1', tokenHash: hashRefreshToken(RAW) }]);
    expect(repo.revokeCalls[0].tokenHash).not.toBe(RAW);
  });

  it('denylists the presented access token until its exp (seconds → Date)', async () => {
    await useCase.execute({ userId: 'u1', accessJti: 'j1', accessExp: EXP, rawRefreshToken: RAW });

    expect(denylist.denyCalls).toEqual([{ jti: 'j1', expiresAt: new Date(EXP * 1000) }]);
  });

  it('resolves void (idempotent — repo/denylist no-op unknown/foreign/revoked tokens)', async () => {
    await expect(
      useCase.execute({ userId: 'u1', accessJti: 'j1', accessExp: EXP, rawRefreshToken: RAW }),
    ).resolves.toBeUndefined();
  });
});
