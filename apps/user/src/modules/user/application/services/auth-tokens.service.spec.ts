import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '../../domain/entities/user.entity';
import type {
  ActiveSession,
  CreateRefreshTokenInput,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  SessionEpochProjectionPort,
} from '../ports';
import { AuthTokensService } from './auth-tokens.service';

class MockRefreshTokenRepository implements RefreshTokenRepositoryPort {
  last?: CreateRefreshTokenInput;

  // Retention is not this service's concern; SweepAuthTokensService owns and tests it.
  deleteCollectable(): Promise<number> {
    return Promise.resolve(0);
  }

  create(input: CreateRefreshTokenInput): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
  // Rotation/revoke aren't exercised here (issuance only) — stub as unused.
  rotate(): Promise<RotateOutcome> {
    return Promise.reject(new Error('unused'));
  }
  revoke(): Promise<void> {
    return Promise.reject(new Error('unused'));
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

class MockEpochProjection implements SessionEpochProjectionPort {
  published: Array<{ userId: string; epoch: number }> = [];
  publish(userId: string, epoch: number): Promise<void> {
    this.published.push({ userId, epoch });
    return Promise.resolve();
  }
  revoke(): Promise<void> {
    return Promise.reject(new Error('unused'));
  }
}

const ttls: Record<string, string> = {
  'auth.jwtAccessTtl': '15m',
  'auth.refreshTokenTtl': '7d',
};
const config = { getOrThrow: (key: string) => ttls[key] } as unknown as ConfigService;

describe('AuthTokensService', () => {
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: 900 } });
  const user = new User('u1', 'user@example.com', '$argon2id$hash', 'CUSTOMER', new Date(), new Date());
  let repo: MockRefreshTokenRepository;
  let projection: MockEpochProjection;
  let service: AuthTokensService;

  beforeEach(() => {
    repo = new MockRefreshTokenRepository();
    projection = new MockEpochProjection();
    service = new AuthTokensService(jwt, config, repo, projection);
  });

  it('signs an access JWT carrying sub + role + email + a unique jti + the session epoch', async () => {
    const { accessToken } = await service.issuePair(user);

    const payload = jwt.verify<{ sub: string; role: string; email: string; jti: string; epoch: number }>(accessToken);
    expect(payload.sub).toBe('u1');
    expect(payload.role).toBe('CUSTOMER');
    expect(payload.email).toBe('user@example.com');
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.jti.length).toBeGreaterThan(0);
    expect(payload.epoch).toBe(0);
  });

  it('publishes the epoch it signed, so the verifier never fails closed on a fresh token', async () => {
    await service.issuePair(user);

    expect(projection.published).toEqual([{ userId: 'u1', epoch: 0 }]);
  });

  it('stamps the user’s current session epoch into the access token', async () => {
    const bumped = User.create({
      id: 'u2',
      email: 'bumped@example.com',
      passwordHash: '$argon2id$hash',
      role: 'CUSTOMER',
      createdAt: new Date(),
      updatedAt: new Date(),
      tokenEpoch: 5,
    });

    const { accessToken } = await service.issuePair(bumped);

    const payload = jwt.verify<{ epoch: number }>(accessToken);
    expect(payload.epoch).toBe(5);
  });

  it('mints a distinct jti per access token (so logout can target one token)', async () => {
    const a = jwt.verify<{ jti: string }>((await service.issuePair(user)).accessToken);
    const b = jwt.verify<{ jti: string }>((await service.issuePair(user)).accessToken);
    expect(a.jti).not.toBe(b.jti);
  });

  it('returns expiresIn in seconds derived from the access TTL', async () => {
    const { expiresIn } = await service.issuePair(user);
    expect(expiresIn).toBe(900);
  });

  it('returns an opaque refresh token and persists ONLY its sha256 hash', async () => {
    const { refreshToken } = await service.issuePair(user);

    expect(refreshToken).toHaveLength(64); // 48 random bytes -> base64url
    const expectedHash = createHash('sha256').update(refreshToken).digest('hex');
    expect(repo.last?.tokenHash).toBe(expectedHash);
    expect(repo.last?.tokenHash).not.toBe(refreshToken);
    expect(repo.last?.userId).toBe('u1');
    expect(repo.last?.familyId).toEqual(expect.any(String));
    expect(repo.last?.familyId.length).toBeGreaterThan(0);
  });

  it('sets the refresh expiry ~7d in the future', async () => {
    const sevenDays = 7 * 86_400_000;
    const before = Date.now();
    await service.issuePair(user);
    const expiresAt = repo.last?.expiresAt.getTime() ?? 0;

    expect(expiresAt).toBeGreaterThanOrEqual(before + sevenDays - 1_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + sevenDays + 1_000);
  });

  it('issues a distinct refresh token + familyId per call', async () => {
    const a = await service.issuePair(user);
    const familyA = repo.last?.familyId;
    const b = await service.issuePair(user);
    const familyB = repo.last?.familyId;

    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(familyA).not.toBe(familyB);
  });
});
