import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config/config.module';
import { DrizzleModule } from './shared/infrastructure/database/drizzle.module';
import { RedisModule } from './shared/infrastructure/redis/redis.module';
import { HealthModule } from './shared/health/health.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { UserModule } from './modules/user/user.module';
import { AuthModule } from './modules/user/auth.module';

// Root module. Global infrastructure (config, database, redis) + feature modules.
// DrizzleModule/RedisModule are @Global so repositories inject them without re-importing.
@Module({
  imports: [ConfigModule, DrizzleModule, RedisModule, HealthModule, CatalogModule, UserModule, AuthModule],
})
export class AppModule {}
