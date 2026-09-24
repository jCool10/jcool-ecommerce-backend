import { createHash } from 'node:crypto';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { User } from '../../domain/entities/user.entity';
import { EchoAccessTokenSigner, claimsOf } from '../../testing/access-token-signer.double';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { AuthTokensService } from './auth-tokens.service';

const NOW = new Date('2026-09-24T08:00:00.000Z');
const SEVEN_DAYS_MS = 7 * 86_400_000;

describe('AuthTokensService', () => {
  useFakeClock(NOW);

  const user = User.create({
    id: 'u1',
    email: 'user@example.com',
    passwordHash: '$argon2id$hash',
    role: 'CUSTOMER',
    createdAt: NOW,
    updatedAt: NOW,
    tokenEpoch: 5,
  });
  let repo: FakeRefreshTokenRepository;
  let service: AuthTokensService;

  beforeEach(() => {
    repo = new FakeRefreshTokenRepository();
    service = new AuthTokensService(
      new EchoAccessTokenSigner(),
      fakeConfigService({ 'auth.refreshTokenTtl': '7d' }),
      repo,
    );
  });

  it("signs the user's id, role and current session epoch under a fresh jti", async () => {
    const { accessToken } = await service.issuePair(user);

    expect(claimsOf(accessToken)).toEqual({ sub: 'u1', role: 'CUSTOMER', jti: expect.any(String) as string, epoch: 5 });
  });

  it('hands out the raw refresh token and persists only its sha256 hash', async () => {
    const { refreshToken } = await service.issuePair(user);

    // 48 random bytes, base64url.
    expect(refreshToken).toHaveLength(64);
    expect(repo.created).toEqual([
      {
        userId: 'u1',
        tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
        familyId: expect.any(String) as string,
        expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
      },
    ]);
  });

  it('opens a new session per call: new jti, refresh token and family', async () => {
    const first = await service.issuePair(user);
    const second = await service.issuePair(user);

    expect(claimsOf(second.accessToken).jti).not.toBe(claimsOf(first.accessToken).jti);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(repo.created[1].familyId).not.toBe(repo.created[0].familyId);
  });
});
