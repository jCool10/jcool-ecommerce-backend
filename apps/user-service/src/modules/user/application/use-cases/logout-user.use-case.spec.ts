import { hashRefreshToken } from '..';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import type { AccessTokenReaderPort, LiveAccessToken, TokenDenylistPort } from '../ports';
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

const readerOf = (live: LiveAccessToken | null): AccessTokenReaderPort => ({ readLive: () => Promise.resolve(live) });

describe('LogoutUserUseCase', () => {
  const exp = 1_700_000_000;

  it("revokes the refresh token's whole session and denylists a live access token until its exp", async () => {
    const refreshTokens = new FakeRefreshTokenRepository();
    refreshTokens.owner = { userId: 'u1', familyId: 'fam1', rotatable: true };
    const denylist = new RecordingDenylist();

    const result = await new LogoutUserUseCase(refreshTokens, denylist, readerOf({ jti: 'j1', exp })).execute({
      rawRefreshToken: 'raw-refresh-token',
      rawAccessToken: 'access',
    });

    expect(result).toEqual({ userId: 'u1' });
    // `exp` is epoch seconds.
    expect(denylist.entries).toEqual([{ jti: 'j1', expiresAt: new Date(exp * 1000) }]);
    expect(refreshTokens.revokedFamilies).toEqual([{ userId: 'u1', familyId: 'fam1' }]);
  });

  it('still ends the session when the access token has expired', async () => {
    const refreshTokens = new FakeRefreshTokenRepository();
    refreshTokens.owner = { userId: 'u1', familyId: 'fam1', rotatable: true };
    const denylist = new RecordingDenylist();

    await new LogoutUserUseCase(refreshTokens, denylist, readerOf(null)).execute({
      rawRefreshToken: 'raw-refresh-token',
      rawAccessToken: 'expired',
    });

    expect(denylist.entries).toEqual([]);
    expect(refreshTokens.revokedFamilies).toEqual([{ userId: 'u1', familyId: 'fam1' }]);
  });

  it('is a silent no-op for a refresh token nobody owns, and with no access token', async () => {
    const refreshTokens = new FakeRefreshTokenRepository();
    const denylist = new RecordingDenylist();

    const result = await new LogoutUserUseCase(refreshTokens, denylist, readerOf(null)).execute({
      rawRefreshToken: 'unknown',
    });

    expect(result).toEqual({ userId: null });
    expect(refreshTokens.revokedFamilies).toEqual([]);
    expect(denylist.entries).toEqual([]);
  });

  it('looks the session up by the hash of the cookie, never the raw value', async () => {
    const refreshTokens = new FakeRefreshTokenRepository();
    await new LogoutUserUseCase(refreshTokens, new RecordingDenylist(), readerOf(null)).execute({
      rawRefreshToken: 'raw-refresh-token',
    });

    expect(refreshTokens.lookedUp).toEqual([hashRefreshToken('raw-refresh-token')]);
  });

  // A non-string cookie value (cookie-parser's `j:` JSON decoding) makes hashing throw; that must
  // surface before any write starts, or its promise is left unhandled.
  it('writes nothing when the refresh token cannot be hashed', async () => {
    const refreshTokens = new FakeRefreshTokenRepository();
    const denylist = new RecordingDenylist();

    await expect(
      new LogoutUserUseCase(refreshTokens, denylist, readerOf({ jti: 'j1', exp })).execute({
        rawRefreshToken: {} as unknown as string,
        rawAccessToken: 'access',
      }),
    ).rejects.toThrow();

    expect(denylist.entries).toEqual([]);
    expect(refreshTokens.revokedFamilies).toEqual([]);
  });
});
