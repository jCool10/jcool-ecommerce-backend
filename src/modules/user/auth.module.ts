import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { durationToMs } from './application/duration-to-ms';
import { REFRESH_TOKEN_REPOSITORY } from './application/ports/refresh-token-repository.port';
import { TOKEN_DENYLIST } from './application/ports/token-denylist.port';
import { AuthTokensService } from './application/services/auth-tokens.service';
import { GetProfileUseCase } from './application/use-cases/get-profile.use-case';
import { LoginUserUseCase } from './application/use-cases/login-user.use-case';
import { LogoutUserUseCase } from './application/use-cases/logout-user.use-case';
import { RefreshTokensUseCase } from './application/use-cases/refresh-tokens.use-case';
import { RegisterUserUseCase } from './application/use-cases/register-user.use-case';
import { DrizzleRefreshTokenRepository } from './infrastructure/drizzle-refresh-token.repository';
import { RedisTokenDenylist } from './infrastructure/redis-token-denylist';
import { AuthController } from './interface/auth.controller';
import { JwtAuthGuard } from './interface/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/rbac/roles.guard';
import { AuthCookieService } from './interface/security/auth-cookie.service';
import { CsrfGuard } from './interface/security/csrf.guard';
import { CsrfTokenService } from './interface/security/csrf-token.service';
import { JwtStrategy } from './interface/strategies/jwt.strategy';
import { UserModule } from './user.module';

/**
 * Auth surface for the User context: register/login, token issuance + rotation,
 * and the two global guards (JwtAuthGuard then RolesGuard). Imports UserModule
 * for its ports and configures JwtModule (HS256). Kept separate from UserModule
 * so persistence and auth stay cleanly split.
 */
@Module({
  imports: [
    UserModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtAccessSecret'),
        // Pass expiresIn as numeric seconds (via durationToMs) to keep TTL parsing uniform.
        signOptions: { expiresIn: Math.floor(durationToMs(config.getOrThrow<string>('auth.jwtAccessTtl')) / 1000) },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    RegisterUserUseCase,
    LoginUserUseCase,
    GetProfileUseCase,
    RefreshTokensUseCase,
    LogoutUserUseCase,
    AuthTokensService,
    JwtStrategy,
    // Phase 2 cookie delivery + CSRF: the cookie writer, the token minter/verifier,
    // and the double-submit guard applied to the refresh/logout routes.
    AuthCookieService,
    CsrfTokenService,
    CsrfGuard,
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: DrizzleRefreshTokenRepository },
    // Redis-backed access-token denylist (RedisService is @Global). Consulted by
    // JwtStrategy on every request; written by logout to revoke the current token.
    { provide: TOKEN_DENYLIST, useClass: RedisTokenDenylist },
    // Two global guards, in order: authenticate (JwtAuthGuard populates
    // request.user) then authorize (RolesGuard reads request.user.role).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
