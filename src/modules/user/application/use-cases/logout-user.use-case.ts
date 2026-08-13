import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '..';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
  TOKEN_DENYLIST,
  type TokenDenylistPort,
} from '../ports';

export interface LogoutInput {
  userId: string;
  /** The presented access token's jti — denylisted so it's rejected immediately. */
  accessJti: string;
  /** The access token's exp (epoch seconds) — the denylist entry's expiry. */
  accessExp: number;
  /** Raw refresh token to revoke alongside (the session's rotation handle). */
  rawRefreshToken: string;
}

/** Log out one session by revoking both halves — denylist the stateless access token until its exp, revoke the presented refresh token — idempotent (unknown/foreign/already-revoked is a silent no-op → always 204) and scoped to this session only. See docs/engineering-notes.md (Auth — Login, register, logout, profile). */
@Injectable()
export class LogoutUserUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(TOKEN_DENYLIST) private readonly denylist: TokenDenylistPort,
  ) {}

  async execute(input: LogoutInput): Promise<void> {
    await Promise.all([
      this.denylist.denylist(input.accessJti, new Date(input.accessExp * 1000)),
      this.refreshTokens.revoke(input.userId, hashRefreshToken(input.rawRefreshToken)),
    ]);
  }
}
