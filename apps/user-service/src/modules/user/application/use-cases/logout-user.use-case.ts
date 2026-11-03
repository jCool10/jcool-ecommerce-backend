import { Inject, Injectable } from '@nestjs/common';
import { hashRefreshToken } from '..';
import {
  ACCESS_TOKEN_READER,
  type AccessTokenReaderPort,
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
  TOKEN_DENYLIST,
  type TokenDenylistPort,
} from '../ports';

export interface LogoutInput {
  /** The refresh cookie, or '' when the client sent none. */
  rawRefreshToken: string;
  /** The bearer token if one came along; it may well have expired. */
  rawAccessToken?: string;
}

/**
 * Authorised by the refresh cookie alone, so a session can still be ended after its access token has
 * expired. Ends the cookie's whole session, and idempotent: an unknown or already-ended token is a
 * silent no-op, so the route always answers 204. A live access token is denylisted as well.
 */
@Injectable()
export class LogoutUserUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepo: RefreshTokenRepositoryPort,
    @Inject(TOKEN_DENYLIST) private readonly tokenDenylist: TokenDenylistPort,
    @Inject(ACCESS_TOKEN_READER) private readonly accessTokenReader: AccessTokenReaderPort,
  ) {}

  /** The user whose session ended, or null when the refresh token named none. */
  async execute(input: LogoutInput): Promise<{ userId: string | null }> {
    // Hashed first: a throw here must happen before either write below starts.
    const refreshTokenHash = hashRefreshToken(input.rawRefreshToken);
    const owner = await this.refreshTokenRepo.findOwner(refreshTokenHash);
    const live = input.rawAccessToken ? await this.accessTokenReader.readLive(input.rawAccessToken) : null;

    await Promise.all([
      live ? this.tokenDenylist.denylist(live.jti, new Date(live.exp * 1000)) : undefined,
      // Under the lock a rotation takes, so a rotation in flight leaves no live successor behind.
      owner ? this.refreshTokenRepo.revokeFamily(owner.userId, owner.familyId) : undefined,
    ]);
    return { userId: owner?.userId ?? null };
  }
}
