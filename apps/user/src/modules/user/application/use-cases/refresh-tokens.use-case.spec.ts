import { Logger, UnauthorizedException } from '@nestjs/common';
import type {
  ActiveSession,
  AuthAuditPort,
  AuthAuditRecord,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
} from '../ports';
import { hashRefreshToken } from '..';
import type { AuthTokens, AuthTokensService, IssuedRefreshToken, SessionService } from '../services';
import { RefreshTokensUseCase } from './refresh-tokens.use-case';

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
  signAccessCalls: Array<{ sub: string; role: string; email: string; epoch: number }> = [];

  get accessExpiresIn(): number {
    return 900;
  }
  newRefreshToken(): IssuedRefreshToken {
    return SUCCESSOR;
  }
  signAccess(sub: string, role: string, email: string, epoch = 0): Promise<string> {
    this.signAccessCalls.push({ sub, role, email, epoch });
    return Promise.resolve('signed-access-token');
  }
}

class MockAuthAudit implements AuthAuditPort {
  readonly records: AuthAuditRecord[] = [];
  record(entry: AuthAuditRecord): void {
    this.records.push(entry);
  }
}

class MockSessionService {
  readonly bumps: string[] = [];
  revokeAccessTokens(userId: string): Promise<void> {
    this.bumps.push(userId);
    return Promise.resolve();
  }
}

describe('RefreshTokensUseCase', () => {
  const PRESENTED_RAW = 'presented-raw-refresh-token';
  let repo: MockRefreshTokenRepository;
  let authTokens: MockAuthTokensService;
  let audit: MockAuthAudit;
  let sessions: MockSessionService;
  let useCase: RefreshTokensUseCase;

  beforeEach(() => {
    repo = new MockRefreshTokenRepository();
    authTokens = new MockAuthTokensService();
    audit = new MockAuthAudit();
    sessions = new MockSessionService();
    useCase = new RefreshTokensUseCase(
      repo,
      authTokens as unknown as AuthTokensService,
      audit,
      sessions as unknown as SessionService,
    );
  });

  it('rotates a valid token: hashes the presented token, passes the successor, returns the new pair', async () => {
    repo.outcome = { status: 'rotated', userId: 'u1', role: 'CUSTOMER', email: 'u1@example.com', tokenEpoch: 3 };

    const result: AuthTokens = await useCase.execute(PRESENTED_RAW);

    expect(repo.lastRotate).toEqual({
      presentedTokenHash: hashRefreshToken(PRESENTED_RAW),
      newTokenHash: SUCCESSOR.hash,
      newExpiresAt: SUCCESSOR.expiresAt,
    });
    expect(authTokens.signAccessCalls).toEqual([{ sub: 'u1', role: 'CUSTOMER', email: 'u1@example.com', epoch: 3 }]);
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
    expect(audit.records).toEqual([
      {
        event: 'token.reuse_detected',
        outcome: 'failure',
        userId: 'u1',
        reason: 'refresh_token_reuse',
        metadata: { familyId: 'fam1' },
      },
    ]);
    expect(sessions.bumps).toEqual(['u1']);

    vi.restoreAllMocks();
  });

  it('replay of a merely-revoked token (logout/killed family) logs debug, not a theft warn', async () => {
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: false };
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(audit.records).toHaveLength(0);
    // No epoch bump, so the user's other live sessions stay signed in.
    expect(sessions.bumps).toHaveLength(0);

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
