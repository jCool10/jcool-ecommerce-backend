import { Module } from '@nestjs/common';
import { SESSION_EPOCH, SESSION_EPOCH_CHANGES, SESSION_EPOCH_PUBLISHER, TOKEN_DENYLIST } from './application/ports';
import { DrizzleSessionEpochRepository } from './infrastructure/drizzle-session-epoch.repository';
import { RedisSessionEpochPublisher } from './infrastructure/redis-session-epoch.publisher';
import { RedisTokenDenylist } from './infrastructure/redis-token-denylist';

/** Revocation state: read by the token verifier, written by the auth flows. */
@Module({
  providers: [
    DrizzleSessionEpochRepository,
    { provide: SESSION_EPOCH, useExisting: DrizzleSessionEpochRepository },
    { provide: SESSION_EPOCH_CHANGES, useExisting: DrizzleSessionEpochRepository },
    { provide: SESSION_EPOCH_PUBLISHER, useClass: RedisSessionEpochPublisher },
    { provide: TOKEN_DENYLIST, useClass: RedisTokenDenylist },
  ],
  exports: [SESSION_EPOCH, SESSION_EPOCH_CHANGES, SESSION_EPOCH_PUBLISHER, TOKEN_DENYLIST],
})
export class SessionStateModule {}
