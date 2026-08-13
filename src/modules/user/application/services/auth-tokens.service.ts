import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v7 as uuidv7 } from 'uuid';
import type { User } from '../../domain/entities/user.entity';
import type { Role } from '../../../../shared/rbac/role.enum';
import type { AccessTokenClaims } from '../access-token-claims';
import { durationToMs } from '../duration-to-ms';
import { hashRefreshToken } from '../hash-refresh-token';
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepositoryPort } from '../ports/refresh-token-repository.port';

/** Token pair returned to the client on register-then-login / login / refresh. */
export interface AuthTokens {
  /** Signed JWT (HS256). */
  accessToken: string;
  /** Opaque high-entropy string; only the SHA-256 hash is persisted. */
  refreshToken: string;
  /** Access-token lifetime in seconds (client hint for proactive refresh). */
  expiresIn: number;
}

/** A freshly minted opaque refresh token + the fields needed to persist it. */
export interface IssuedRefreshToken {
  /** Raw token — returned to the client once, never stored. */
  raw: string;
  /** SHA-256 hex of `raw` — this is what gets persisted / looked up. */
  hash: string;
  expiresAt: Date;
}

/**
 * Issues the access + refresh token pair, keeping token mechanics out of the use cases.
 * See docs/engineering-notes.md (Auth — Token model).
 */
@Injectable()
export class AuthTokensService {
  private readonly accessExpiresInSeconds: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepositoryPort,
  ) {
    // Mirror JwtModule's signOptions TTL as seconds for the `expiresIn` hint.
    this.accessExpiresInSeconds = Math.floor(durationToMs(config.getOrThrow<string>('auth.jwtAccessTtl')) / 1000);
    this.refreshTtlMs = durationToMs(config.getOrThrow<string>('auth.refreshTokenTtl'));
  }

  /** Access-token lifetime in seconds (the `expiresIn` client hint). */
  get accessExpiresIn(): number {
    return this.accessExpiresInSeconds;
  }

  // Fresh jti per token (so logout can denylist exactly this one) + the user's session epoch at issue time.
  signAccess(sub: string, role: Role, epoch = 0): Promise<string> {
    const claims: AccessTokenClaims = { sub, role, jti: uuidv7(), epoch };
    return this.jwt.signAsync(claims);
  }

  // Mint an opaque refresh token; raw returned once, only its hash persisted. Caller owns family + persistence.
  newRefreshToken(): IssuedRefreshToken {
    const raw = randomBytes(48).toString('base64url');
    return { raw, hash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + this.refreshTtlMs) };
  }

  async issuePair(user: User): Promise<AuthTokens> {
    const accessToken = await this.signAccess(user.id, user.role, user.tokenEpoch);

    // Login opens a fresh token family (= one session/device).
    const refresh = this.newRefreshToken();
    await this.refreshTokens.create({
      userId: user.id,
      tokenHash: refresh.hash,
      familyId: uuidv7(),
      expiresAt: refresh.expiresAt,
    });

    return {
      accessToken,
      refreshToken: refresh.raw,
      expiresIn: this.accessExpiresInSeconds,
    };
  }
}
