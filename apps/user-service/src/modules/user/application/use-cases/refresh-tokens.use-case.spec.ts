import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type {
  ActiveSession,
  AuthAuditPort,
  AuthAuditRecord,
  RefreshTokenOwner,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
  SessionEpochPort,
} from '../ports';
import { hashRefreshToken } from '..';
import type { AuthTokens, AuthTokensService, IdentityService, IssuedRefreshToken } from '../services';
import { RefreshTokensUseCase } from './refresh-tokens.use-case';

const SUCCESSOR: IssuedRefreshToken = {
  raw: 'new-raw-refresh-token',
  hash: 'new-token-hash',
  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
};

const SUCCESSOR_ID = 'minted-successor-id';

class MockRefreshTokenRepository implements RefreshTokenRepositoryPort {
  owner: RefreshTokenOwner | null = { userId: 'u1', rotatable: true };
  outcome: RotateOutcome = { status: 'invalid' };

  constructor(private readonly calls: string[]) {}

  // Retention is not this use case's concern; SweepAuthTokensService owns and tests it.
  deleteCollectable(): Promise<number> {
    return Promise.resolve(0);
  }

  lastRotate?: RotateRefreshTokenInput;

  create(): Promise<void> {
    return Promise.reject(new Error('unused'));
  }
  findOwner(): Promise<RefreshTokenOwner | null> {
    this.calls.push('findOwner');
    return Promise.resolve(this.owner);
  }
  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome> {
    this.calls.push('rotate');
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

class MockAuthAudit implements AuthAuditPort {
  readonly records: AuthAuditRecord[] = [];
  record(entry: AuthAuditRecord): void {
    this.records.push(entry);
  }
}

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
  let calls: string[];
  let repo: MockRefreshTokenRepository;
  let mintOwnedBy: Mock<(userId: string) => Promise<string>>;
  let authTokens: MockAuthTokensService;
  let audit: MockAuthAudit;
  let sessionEpoch: MockSessionEpoch;
  let useCase: RefreshTokensUseCase;
  let warn: Mock;
  let debug: Mock;

  beforeEach(() => {
    calls = [];
    repo = new MockRefreshTokenRepository(calls);
    mintOwnedBy = vi.fn(() => {
      calls.push('mint');
      return Promise.resolve(SUCCESSOR_ID);
    });
    authTokens = new MockAuthTokensService();
    audit = new MockAuthAudit();
    sessionEpoch = new MockSessionEpoch();
    warn = vi.fn();
    debug = vi.fn();
    useCase = new RefreshTokensUseCase(
      repo,
      { mintOwnedBy } as unknown as IdentityService,
      authTokens as unknown as AuthTokensService,
      audit,
      sessionEpoch,
      fakePinoLogger({ warn, debug }),
    );
  });

  it('rotates a valid token: hashes the presented token, passes the successor, returns the new pair', async () => {
    repo.outcome = { status: 'rotated', userId: 'u1', role: 'CUSTOMER', tokenEpoch: 3 };

    const result: AuthTokens = await useCase.execute(PRESENTED_RAW);

    expect(repo.lastRotate).toEqual({
      presentedTokenHash: hashRefreshToken(PRESENTED_RAW),
      expectedUserId: 'u1',
      successorId: SUCCESSOR_ID,
      newTokenHash: SUCCESSOR.hash,
      newExpiresAt: SUCCESSOR.expiresAt,
    });
    expect(authTokens.signAccessCalls).toEqual([{ sub: 'u1', role: 'CUSTOMER', epoch: 3 }]);
    expect(result).toEqual({
      accessToken: 'signed-access-token',
      refreshToken: SUCCESSOR.raw,
      expiresIn: 900,
    });
  });

  it("mints the successor's id in its owner's bucket before the row lock is taken", async () => {
    repo.outcome = { status: 'rotated', userId: 'u1', role: 'CUSTOMER', tokenEpoch: 0 };

    await useCase.execute(PRESENTED_RAW);

    expect(calls).toEqual(['findOwner', 'mint', 'rotate']);
    expect(mintOwnedBy).toHaveBeenCalledExactlyOnceWith('u1');
  });

  it('answers an unknown token with 401 without minting or locking anything', async () => {
    repo.owner = null;

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(calls).toEqual(['findOwner']);
  });

  it('detects reuse of a retired token without asking the id service for anything', async () => {
    repo.owner = { userId: 'u1', rotatable: false };
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: true };

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(calls).toEqual(['findOwner', 'rotate']);
    expect(repo.lastRotate?.successorId).toBeNull();
    expect(sessionEpoch.bumps).toEqual(['u1']);
  });

  it('leaves the presented token untouched when no id can be minted', async () => {
    mintOwnedBy.mockRejectedValue(new ServiceUnavailableException());

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(calls).toEqual(['findOwner']);
  });

  it('throws 401 for an invalid/expired/unknown token and signs nothing', async () => {
    repo.outcome = { status: 'invalid' };

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authTokens.signAccessCalls).toHaveLength(0);
  });

  it('reuse of a SUPERSEDED token (replaced) warns loud (theft signal) and issues no token', async () => {
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: true };

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    // The user and family are fields: a theft alert is only actionable if it can be pivoted on.
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { userId: 'u1', familyId: 'fam1' },
      'refresh token reuse detected — session revoked',
    );
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
    expect(sessionEpoch.bumps).toEqual(['u1']);
  });

  it('replay of a merely-revoked token (logout/killed family) logs debug, not a theft warn', async () => {
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: false };

    await expect(useCase.execute(PRESENTED_RAW)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      { userId: 'u1', familyId: 'fam1' },
      'revoked refresh token replayed — session already ended',
    );
    expect(audit.records).toHaveLength(0);
    // No epoch bump, so the user's other live sessions stay signed in.
    expect(sessionEpoch.bumps).toHaveLength(0);
  });

  it('uses the same generic 401 message for invalid and reuse (no reason leaked)', async () => {
    repo.outcome = { status: 'invalid' };
    const invalid = await useCase.execute(PRESENTED_RAW).catch((e: Error) => e);
    repo.outcome = { status: 'reuse', userId: 'u1', familyId: 'fam1', replaced: true };
    const reuse = await useCase.execute(PRESENTED_RAW).catch((e: Error) => e);

    expect((invalid as Error).message).toBe((reuse as Error).message);
  });
});
