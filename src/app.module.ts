import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config';
import { DrizzleModule } from './shared/infrastructure/database';
import { RedisModule } from './shared/infrastructure/redis';
import { ThrottlerSecurityModule } from './shared/infrastructure/throttler';
import { HealthModule } from './shared/health';
import { CatalogModule } from './modules/catalog/catalog.module';
import { UserModule } from './modules/user/user.module';
import { AuthModule } from './modules/user/auth.module';

// Root module: global infrastructure (config, database, redis @Global) + feature modules;
// ThrottlerSecurityModule precedes AuthModule so its rate-limit guard runs before the auth guards.
@Module({
  imports: [
    ConfigModule,
    DrizzleModule,
    RedisModule,
    ThrottlerSecurityModule,
    HealthModule,
    CatalogModule,
    UserModule,
    AuthModule,
  ],
})
export class AppModule {}
