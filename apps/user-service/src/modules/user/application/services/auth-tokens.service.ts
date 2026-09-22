import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';
import type { User } from '../../domain/entities/user.entity';
import type { Role } from '@jcool/platform/rbac';
import { durationToMs, hashRefreshToken } from '..';
import {
  ACCESS_TOKEN_SIGNER,
  type AccessTokenSignerPort,
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
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
  private readonly refreshTtlMs: number;

  constructor(
    @Inject(ACCESS_TOKEN_SIGNER) private readonly signer: AccessTokenSignerPort,
    config: ConfigService,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepositoryPort,
  ) {
    this.refreshTtlMs = durationToMs(config.getOrThrow<string>('auth.refreshTokenTtl'));
  }

  get accessExpiresIn(): number {
    return this.signer.expiresIn;
  }

  // Fresh jti per token, so logout can denylist exactly this one.
  signAccess(sub: string, role: Role, epoch = 0): Promise<string> {
    return this.signer.sign({ sub, role, jti: uuidv7(), epoch });
  }

  // Mints only: the caller owns the family id and the persistence.
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
      expiresIn: this.signer.expiresIn,
    };
  }
}
