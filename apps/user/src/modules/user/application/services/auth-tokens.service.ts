import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v7 as uuidv7 } from 'uuid';
import type { User } from '../../domain/entities/user.entity';
import type { AccessTokenClaims } from '@shared/auth';
import type { Role } from '@shared/rbac';
import { durationToMs, hashRefreshToken } from '..';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
  SESSION_EPOCH_PROJECTION,
  type SessionEpochProjectionPort,
} from '../ports';

export interface AuthTokens {
  /** Signed JWT (ES256). */
  accessToken: string;
  /** Opaque high-entropy string; only the SHA-256 hash is persisted. */
  refreshToken: string;
  /** Seconds — a client hint for proactive refresh. */
  expiresIn: number;
}

export interface IssuedRefreshToken {
  /** Returned to the client once, never stored. */
  raw: string;
  /** SHA-256 hex of `raw` — this is what gets persisted and looked up. */
  hash: string;
  expiresAt: Date;
}

@Injectable()
export class AuthTokensService {
  private readonly accessExpiresInSeconds: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(SESSION_EPOCH_PROJECTION)
    private readonly epochProjection: SessionEpochProjectionPort,
  ) {
    // Mirror JwtModule's signOptions TTL as seconds for the `expiresIn` hint.
    this.accessExpiresInSeconds = Math.floor(durationToMs(config.getOrThrow<string>('auth.jwtAccessTtl')) / 1000);
    this.refreshTtlMs = durationToMs(config.getOrThrow<string>('auth.refreshTokenTtl'));
  }

  get accessExpiresIn(): number {
    return this.accessExpiresInSeconds;
  }

  // Fresh jti per token, so logout can denylist exactly this one. Every mint refreshes the epoch
  // projection: the verifier fails closed on a missing key, so a token must never outlive it.
  async signAccess(sub: string, role: Role, email: string, epoch = 0): Promise<string> {
    await this.epochProjection.publish(sub, epoch);
    const claims: AccessTokenClaims = { sub, role, email, jti: uuidv7(), epoch };
    return this.jwt.signAsync(claims);
  }

  // Mints only: the caller owns the family id and the persistence.
  newRefreshToken(): IssuedRefreshToken {
    const raw = randomBytes(48).toString('base64url');
    return { raw, hash: hashRefreshToken(raw), expiresAt: new Date(Date.now() + this.refreshTtlMs) };
  }

  async issuePair(user: User): Promise<AuthTokens> {
    const accessToken = await this.signAccess(user.id, user.role, user.email, user.tokenEpoch);

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
