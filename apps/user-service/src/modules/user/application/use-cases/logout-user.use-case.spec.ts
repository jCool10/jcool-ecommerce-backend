import { hashRefreshToken } from '..';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import type { TokenDenylistPort } from '../ports';
import { LogoutUserUseCase } from './logout-user.use-case';

class RecordingDenylist implements TokenDenylistPort {
  readonly entries: Array<{ jti: string; expiresAt: Date }> = [];

  denylist(jti: string, expiresAt: Date): Promise<void> {
    this.entries.push({ jti, expiresAt });
    return Promise.resolve();
  }
  isDenylisted(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe('LogoutUserUseCase', () => {
  it("denylists the access token until its exp and revokes this session's refresh", async () => {
    const refreshTokens = new FakeRefreshTokenRepository();
    const denylist = new RecordingDenylist();
    const exp = 1_700_000_000;

    await new LogoutUserUseCase(refreshTokens, denylist).execute({
      userId: 'u1',
      accessJti: 'j1',
      accessExp: exp,
      rawRefreshToken: 'raw-refresh-token',
    });

    // `exp` is epoch seconds.
    expect(denylist.entries).toEqual([{ jti: 'j1', expiresAt: new Date(exp * 1000) }]);
    expect(refreshTokens.revoked).toEqual([{ userId: 'u1', tokenHash: hashRefreshToken('raw-refresh-token') }]);
  });
});
