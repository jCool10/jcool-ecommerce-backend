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
  accessJti: string;
  /** Epoch seconds. */
  accessExp: number;
  rawRefreshToken: string;
}

/**
 * Scoped to this one session, and idempotent: an unknown, foreign or already-revoked token is a
 * silent no-op, so the route always answers 204.
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
