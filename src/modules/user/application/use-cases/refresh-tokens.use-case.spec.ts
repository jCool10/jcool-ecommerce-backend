import { Logger, UnauthorizedException } from '@nestjs/common';
import type {
  ActiveSession,
  AuthAuditPort,
  AuthAuditRecord,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
  SessionEpochPort,
} from '../ports';
import { hashRefreshToken } from '..';
import type { AuthTokens, AuthTokensService, IssuedRefreshToken } from '../services';
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

  // Retention is not this use case's concern; SweepAuthTokensService owns and tests it.
  deleteCollectable(): Promise<number> {
    return Promise.resolve(0);
  }

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

class MockAuthTokensService {
  signAccessCalls: Array<{ sub: string; role: string; epoch: number }> = [];

  get accessExpiresIn(): number {
    return 900;
  }
  newRefreshToken(): IssuedRefreshToken {
    return SUCCESSOR;
  }
  signAccess(sub: string, role: string, epoch = 0): Promise<string> {
    this.signAccessCalls.push({ sub, role, epoch });
    return Promise.resolve('signed-access-token');
  }
}

// Records whatever the use case audits so tests can assert the reuse event.
class MockAuthAudit implements AuthAuditPort {
  readonly records: AuthAuditRecord[] = [];
  record(entry: AuthAuditRecord): void {
    this.records.push(entry);
  }
}

// Records epoch bumps so tests can assert the theft response kills access tokens too.
class MockSessionEpoch implements SessionEpochPort {
  readonly bumps: string[] = [];
  current(): Promise<number | null> {
    return Promise.reject(new Error('unused'));
  }
  bump(userId: string): Promise<number> {
    this.bumps.push(userId);
    return Promise.resolve(this.bumps.length);
  }
}

describe('RefreshTokensUseCase', () => {
  const PRESENTED_RAW = 'presented-raw-refresh-token';
  let repo: MockRefreshTokenRepository;
  let authTokens: MockAuthTokensService;
  let audit: MockAuthAudit;
  let sessionEpoch: MockSessionEpoch;
  let useCase: RefreshTokensUseCase;

  beforeEach(() => {
    repo = new MockRefreshTokenRepository();
    authTokens = new MockAuthTokensService();
    audit = new MockAuthAudit();
    sessionEpoch = new MockSessionEpoch();
    useCase = new RefreshTokensUseCase(repo, authTokens as unknown as AuthTokensService, audit, sessionEpoch);
  });

  it('rotates a valid token: hashes the presented token, passes the successor, returns the new pair', async () => {
    repo.outcome = { status: 'rotated', userId: 'u1', role: 'CUSTOMER', tokenEpoch: 3 };

    const result: AuthTokens = await useCase.execute(PRESENTED_RAW);

    // Presented token is looked up by hash (never raw); successor is handed to rotate.
    expect(repo.lastRotate).toEqual({
      presentedTokenHash: hashRefreshToken(PRESENTED_RAW),
      newTokenHash: SUCCESSOR.hash,
      newExpiresAt: SUCCESSOR.expiresAt,
    });
    // Access token signed with the *fresh* role + session epoch read during rotation.
    expect(authTokens.signAccessCalls).toEqual([{ sub: 'u1', role: 'CUSTOMER', epoch: 3 }]);
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
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
    expect(authTokens.signAccessCalls).toHaveLength(0);
    // Real reuse is audited as a security event, tagged with the family.
    expect(audit.records).toEqual([
      {
        event: 'token.reuse_detected',
        outcome: 'failure',
        userId: 'u1',
        reason: 'refresh_token_reuse',
        metadata: { familyId: 'fam1' },
      },
    ]);
    // Theft response also bumps the epoch → the thief's outstanding access token dies now.
    expect(sessionEpoch.bumps).toEqual(['u1']);

    vi.restoreAllMocks();
  });

  it('replay of a merely-revoked token (logout/killed family) logs debug, not a theft warn', async () => {
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: false };
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    // Benign revoked-token replay is a diagnostic, not an audited security event.
    expect(audit.records).toHaveLength(0);
    // ...and does not bump the epoch, so a user's other live sessions stay signed in.
    expect(sessionEpoch.bumps).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it('uses the same generic 401 message for invalid and reuse (no reason leaked)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    repo.outcome = { status: 'invalid' };
    const invalid = await useCase.execute(PRESENTED_RAW).catch((e: Error) => e);
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: true };
    const reuse = await useCase.execute(PRESENTED_RAW).catch((e: Error) => e);

    expect((invalid as Error).message).toBe((reuse as Error).message);
    vi.restoreAllMocks();
  });
});
