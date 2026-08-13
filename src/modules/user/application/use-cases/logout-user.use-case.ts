import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '../hash-refresh-token';
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepositoryPort } from '../ports/refresh-token-repository.port';
import { TOKEN_DENYLIST, type TokenDenylistPort } from '../ports/token-denylist.port';

export interface LogoutInput {
  userId: string;
  /** The presented access token's jti — denylisted so it's rejected immediately. */
  accessJti: string;
  /** The access token's exp (epoch seconds) — the denylist entry's expiry. */
  accessExp: number;
  /** Raw refresh token to revoke alongside (the session's rotation handle). */
  rawRefreshToken: string;
}

/**
 * Log out one session by revoking BOTH halves: denylist the stateless access
 * token (until its exp) so it stops working now, and revoke the presented
 * refresh token so it can't mint new access tokens. Idempotent — an unknown/
 * foreign/already-revoked token is a silent no-op, so the controller always
 * returns 204. Scope is this session only, not the whole token family.
 */
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
