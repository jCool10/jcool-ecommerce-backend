import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { RedisModule } from '@shared/infrastructure/redis';
import { RolesGuard } from '@shared/rbac';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { RedisSessionEpochReader } from './redis-session-epoch.reader';
import { RedisTokenDenylist } from './redis-token-denylist';
import { SESSION_EPOCH_READER } from './session-epoch-reader.port';
import { TOKEN_DENYLIST } from './token-denylist.port';

/**
 * Everything needed to authenticate a request and nothing needed to issue one: no private key, no
 * database. An app that imports this can verify tokens the user service signed.
 */
@Module({
  imports: [PassportModule, RedisModule],
  providers: [
    JwtStrategy,
    { provide: TOKEN_DENYLIST, useClass: RedisTokenDenylist },
    { provide: SESSION_EPOCH_READER, useClass: RedisSessionEpochReader },
    // Order matters: authenticate (JwtAuthGuard) before authorize (RolesGuard).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TOKEN_DENYLIST, SESSION_EPOCH_READER],
})
export class AuthVerifyModule {}
