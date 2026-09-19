import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { createLocalJWKSet } from 'jose';
import { ClsModule } from 'nestjs-cls';
import { AuthVerifierModule } from '@jcool/auth-verifier';
import { DrizzleModule } from '@jcool/platform/database';
import { HealthModule } from '@jcool/platform/health';
import { HttpExceptionFilter } from '@jcool/platform/interface';
import { MetricsModule } from '@jcool/platform/metrics';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@jcool/platform/observability';
import { RedisModule } from '@jcool/platform/redis';
import { RetentionModule } from '@jcool/platform/retention';
import { ThrottlerSecurityModule } from '@jcool/platform/throttler';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import * as schema from './database/schema';
import { AccessTokenKeysModule } from './modules/user/access-token-keys.module';
import { AuthModule } from './modules/user/auth.module';
import { Es256SigningKeys } from './modules/user/infrastructure/es256-signing-keys';
import { SessionStateModule } from './modules/user/session-state.module';
import { UserModule } from './modules/user/user.module';
import { RedisDurabilityCheck } from './redis/redis-durability.check';

// ClsModule precedes the logger so its correlation middleware mounts before pino's.
// ThrottlerSecurityModule precedes AuthVerifierModule: global guards run in module-scan order.
@Module({
  imports: [
    // `node --env-file-if-exists` already loaded .env; reading it again here would let a stray file
    // override what a test or the platform set.
    ConfigModule.forRoot({ isGlobal: true, validate, load: [configuration], ignoreEnvFile: true }),
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    DrizzleModule.forRoot({ schema }),
    RedisModule,
    RetentionModule,
    ScheduleModule.forRoot(),
    ThrottlerSecurityModule,
    AuthVerifierModule.forRootAsync({
      imports: [SessionStateModule, AccessTokenKeysModule],
      inject: [ConfigService, Es256SigningKeys],
      useFactory: (config: ConfigService, keys: Es256SigningKeys) => ({
        hs256: {
          enabled: config.getOrThrow<boolean>('auth.hs256Enabled'),
          secret: config.get<string>('auth.jwtAccessSecret'),
        },
        es256: {
          keys: createLocalJWKSet(keys.jwks),
          issuer: config.getOrThrow<string>('auth.issuer'),
          audience: config.getOrThrow<string>('auth.audience'),
        },
      }),
    }),
    HealthModule,
    UserModule,
    AuthModule,
  ],
  providers: [
    RedisDurabilityCheck,
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
