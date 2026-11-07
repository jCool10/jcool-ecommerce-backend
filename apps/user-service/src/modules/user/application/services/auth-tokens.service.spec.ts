import { createHash } from 'node:crypto';
import { encode, isRoutableId } from '@jcool/id-codec';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { User } from '../../domain/entities/user.entity';
import { EchoAccessTokenSigner, claimsOf } from '../../testing/access-token-signer.double';
import { RecordingIdGenerator } from '../../testing/id-generator.double';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { AuthTokensService } from './auth-tokens.service';
import { IdGeneratorService } from './id-generator.service';

const NOW = new Date('2026-09-24T08:00:00.000Z');
const SEVEN_DAYS_MS = 7 * 86_400_000;
const USER_ID = encode({ tsMs: NOW.getTime(), nodeId: 1, sequence: 0 });

describe('AuthTokensService', () => {
  useFakeClock(NOW);

  const user = User.create({
    id: USER_ID,
    email: 'user@example.com',
    passwordHash: '$argon2id$hash',
    role: 'CUSTOMER',
    createdAt: NOW,
    updatedAt: NOW,
    tokenEpoch: 5,
  });
  let repo: FakeRefreshTokenRepository;
  let ids: RecordingIdGenerator;
  let service: AuthTokensService;

  beforeEach(() => {
    repo = new FakeRefreshTokenRepository();
    ids = new RecordingIdGenerator();
    service = new AuthTokensService(
      new EchoAccessTokenSigner(),
      fakeConfigService({ 'auth.refreshTokenTtl': '7d' }),
      repo,
      new IdGeneratorService(ids),
    );
  });

  const issued = async () => {
    const tokens = await service.issuePair(user);
    if (!tokens) throw new Error('expected a token pair');
    return tokens;
  };

  // The user was read before the password check; the row read where the session is stored is newer.
  it('signs the access token with the role and epoch read where the session was stored', async () => {
    repo.createOutcome = { status: 'created', role: 'ADMIN', tokenEpoch: 7 };

    const { accessToken } = await issued();

    expect(claimsOf(accessToken)).toEqual({
      sub: USER_ID,
      role: 'ADMIN',
      jti: expect.any(String) as string,
      epoch: 7,
    });
  });

  it('names the new session with a freshly minted id', async () => {
    await issued();

    expect(ids.requests).toEqual([1]);
    expect(isRoutableId(repo.created[0].familyId)).toBe(true);
  });

  it('hands out the raw refresh token and persists only its sha256 hash, bound to the verified hash', async () => {
    const { refreshToken } = await issued();

    // 48 random bytes, base64url.
    expect(refreshToken).toHaveLength(64);
    expect(repo.created).toEqual([
      {
        userId: USER_ID,
        tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
        familyId: expect.any(String) as string,
        expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
        verifiedPasswordHash: '$argon2id$hash',
      },
    ]);
  });

  it('issues nothing when the verified password was replaced before the session was stored', async () => {
    repo.createOutcome = { status: 'credentials_changed' };

    await expect(service.issuePair(user)).resolves.toBeNull();
  });

  it('opens a new session per call: new jti, refresh token and family', async () => {
    const first = await issued();
    const second = await issued();

    expect(claimsOf(second.accessToken).jti).not.toBe(claimsOf(first.accessToken).jti);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(repo.created[1].familyId).not.toBe(repo.created[0].familyId);
  });
});
