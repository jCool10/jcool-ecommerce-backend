import { UnauthorizedException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { EPOCH_MS, encode } from '@jcool/id-codec';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { hashRefreshToken } from '..';
import { EchoAccessTokenSigner, claimsOf } from '../../testing/access-token-signer.double';
import { RecordingAuthAudit } from '../../testing/recording-auth-audit.double';
import { FakeRefreshTokenRepository } from '../../testing/refresh-token-repository.double';
import { FakeSessionEpoch } from '../../testing/session-epoch.double';
import type { IdGeneratorPort } from '../ports';
import { AuthTokensService, IdGeneratorService } from '../services';
import { RefreshTokensUseCase } from './refresh-tokens.use-case';

const OWNER = encode({ tsMs: EPOCH_MS + 1, nodeId: 1, sequence: 0 });
const PRESENTED = 'presented-raw-refresh-token';

describe('RefreshTokensUseCase', () => {
  let log: string[];
  let refreshTokens: FakeRefreshTokenRepository;
  let signer: EchoAccessTokenSigner;
  let audit: RecordingAuthAudit;
  let epochs: FakeSessionEpoch;
  let warn: Mock;
  let useCase: RefreshTokensUseCase;

  const refused = (): Promise<unknown> =>
    useCase.execute(PRESENTED).then(
      () => 'rotated',
      (error: unknown) => error,
    );

  beforeEach(() => {
    log = [];
    const ids: IdGeneratorPort = {
      mint: () => {
        log.push('mint');
        return Promise.resolve(['successor']);
      },
    };
    refreshTokens = new FakeRefreshTokenRepository(log);
    refreshTokens.owner = { userId: OWNER, rotatable: true };
    signer = new EchoAccessTokenSigner();
    audit = new RecordingAuthAudit();
    epochs = new FakeSessionEpoch();
    warn = vi.fn();
    const idGeneratorService = new IdGeneratorService(ids);
    useCase = new RefreshTokensUseCase(
      refreshTokens,
      idGeneratorService,
      new AuthTokensService(
        signer,
        fakeConfigService({ 'auth.refreshTokenTtl': '7d' }),
        refreshTokens,
        idGeneratorService,
      ),
      audit,
      epochs,
      fakePinoLogger({ warn }),
    );
  });

  it('rotates a valid token into a new pair carrying the epoch read under the lock', async () => {
    refreshTokens.outcome = { status: 'rotated', userId: OWNER, role: 'CUSTOMER', tokenEpoch: 3 };

    const result = await useCase.execute(PRESENTED);

    expect(refreshTokens.rotations).toEqual([
      {
        presentedTokenHash: hashRefreshToken(PRESENTED),
        expectedUserId: OWNER,
        successorId: 'successor',
        newTokenHash: hashRefreshToken(result.refreshToken),
        newExpiresAt: expect.any(Date) as Date,
      },
    ]);
    expect(claimsOf(result.accessToken)).toMatchObject({ sub: OWNER, role: 'CUSTOMER', epoch: 3 });
    expect(result).toMatchObject({ userId: OWNER, expiresIn: signer.expiresIn });
  });

  it("mints the successor's id before the row lock is taken", async () => {
    refreshTokens.outcome = { status: 'rotated', userId: OWNER, role: 'CUSTOMER', tokenEpoch: 0 };

    await useCase.execute(PRESENTED);

    expect(log).toEqual(['findOwner', 'mint', 'rotate']);
  });

  it('answers an unknown token with 401 without minting or locking anything', async () => {
    refreshTokens.owner = null;

    expect(await refused()).toBeInstanceOf(UnauthorizedException);
    expect(log).toEqual(['findOwner']);
  });

  it('treats a replayed superseded token as theft and bumps the epoch', async () => {
    refreshTokens.owner = { userId: OWNER, rotatable: false };
    refreshTokens.outcome = { status: 'reuse', userId: OWNER, familyId: 'fam1', replaced: true };

    expect(await refused()).toBeInstanceOf(UnauthorizedException);

    // A retired token never waits on the id service.
    expect(log).toEqual(['findOwner', 'rotate']);
    expect(refreshTokens.rotations[0].successorId).toBeNull();
    expect(audit.records).toEqual([
      {
        event: 'token.reuse_detected',
        outcome: 'failure',
        userId: OWNER,
        reason: 'refresh_token_reuse',
        metadata: { familyId: 'fam1' },
      },
    ]);
    // `rotate` only revokes refresh rows; the bump kills the access token the thief already holds.
    expect(epochs.epochs.get(OWNER)).toBe(1);
    // The alert must carry the user and family as fields to be actionable.
    expect(warn).toHaveBeenCalledExactlyOnceWith({ userId: OWNER, familyId: 'fam1' }, expect.any(String));
    expect(signer.signed).toHaveLength(0);
  });

  it('ends a replay of a merely revoked token with 401 and no theft response', async () => {
    refreshTokens.owner = { userId: OWNER, rotatable: false };
    refreshTokens.outcome = { status: 'reuse', userId: OWNER, familyId: 'fam1', replaced: false };

    expect(await refused()).toBeInstanceOf(UnauthorizedException);

    // No bump, so the user's other live sessions stay signed in.
    expect(epochs.epochs.has(OWNER)).toBe(false);
    expect(audit.records).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses an invalid token and a reused one with the same 401 message', async () => {
    refreshTokens.outcome = { status: 'invalid' };
    const invalid = await refused();
    refreshTokens.outcome = { status: 'reuse', userId: OWNER, familyId: 'fam1', replaced: true };
    const reuse = await refused();

    expect(invalid).toBeInstanceOf(UnauthorizedException);
    expect((invalid as Error).message).toBe((reuse as Error).message);
    expect(signer.signed).toHaveLength(0);
  });
});
