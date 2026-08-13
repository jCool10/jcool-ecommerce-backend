import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { durationToMs } from './application/duration-to-ms';
import { AUTH_AUDIT } from './application/ports/auth-audit.port';
import { EMAIL_VERIFICATION_TOKEN_REPOSITORY } from './application/ports/email-verification-token-repository.port';
import { MAILER } from './application/ports/mailer.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from './application/ports/password-reset-token-repository.port';
import { REFRESH_TOKEN_REPOSITORY } from './application/ports/refresh-token-repository.port';
import { SESSION_EPOCH } from './application/ports/session-epoch.port';
import { TOKEN_DENYLIST } from './application/ports/token-denylist.port';
import { AuthTokensService } from './application/services/auth-tokens.service';
import { EmailVerificationService } from './application/services/email-verification.service';
import { PasswordResetService } from './application/services/password-reset.service';
import { SessionService } from './application/services/session.service';
import { ChangePasswordUseCase } from './application/use-cases/change-password.use-case';
import { ForgotPasswordUseCase } from './application/use-cases/forgot-password.use-case';
import { GetProfileUseCase } from './application/use-cases/get-profile.use-case';
import { LoginUserUseCase } from './application/use-cases/login-user.use-case';
import { LogoutUserUseCase } from './application/use-cases/logout-user.use-case';
import { RefreshTokensUseCase } from './application/use-cases/refresh-tokens.use-case';
import { RegisterUserUseCase } from './application/use-cases/register-user.use-case';
import { ResendVerificationUseCase } from './application/use-cases/resend-verification.use-case';
import { AuthAuditLogger } from './infrastructure/auth-audit.logger';
import { DrizzleEmailVerificationTokenRepository } from './infrastructure/drizzle-email-verification-token.repository';
import { DrizzlePasswordResetTokenRepository } from './infrastructure/drizzle-password-reset-token.repository';
import { DrizzleRefreshTokenRepository } from './infrastructure/drizzle-refresh-token.repository';
import { DrizzleSessionEpochRepository } from './infrastructure/drizzle-session-epoch.repository';
import { LogMailer } from './infrastructure/log-mailer';
import { RedisTokenDenylist } from './infrastructure/redis-token-denylist';
import { AuthController } from './interface/auth.controller';
import { JwtAuthGuard } from './interface/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/rbac/roles.guard';
import { AuthCookieService } from './interface/security/auth-cookie.service';
import { CsrfGuard } from './interface/security/csrf.guard';
import { CsrfTokenService } from './interface/security/csrf-token.service';
import { JwtStrategy } from './interface/strategies/jwt.strategy';
import { UserModule } from './user.module';

/** Auth surface for the User context — register/login, token issuance + rotation, and the two global guards (JwtAuthGuard then RolesGuard); imports UserModule for its ports and configures JwtModule (HS256). */
@Module({
  imports: [
    UserModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtAccessSecret'),
        // expiresIn as numeric seconds (via durationToMs) to keep TTL parsing uniform.
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
    EmailVerificationService,
    ResendVerificationUseCase,
    PasswordResetService,
    ForgotPasswordUseCase,
    SessionService,
    ChangePasswordUseCase,
    JwtStrategy,
    AuthCookieService,
    CsrfTokenService,
    CsrfGuard,
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: DrizzleRefreshTokenRepository },
    { provide: EMAIL_VERIFICATION_TOKEN_REPOSITORY, useClass: DrizzleEmailVerificationTokenRepository },
    { provide: PASSWORD_RESET_TOKEN_REPOSITORY, useClass: DrizzlePasswordResetTokenRepository },
    { provide: MAILER, useClass: LogMailer }, // log sink; swap for an SMTP adapter in production
    // Access-token denylist (Redis): read by JwtStrategy per request, written by logout.
    { provide: TOKEN_DENYLIST, useClass: RedisTokenDenylist },
    // Per-user session epoch: read by JwtStrategy per request, bumped for global revocation.
    { provide: SESSION_EPOCH, useClass: DrizzleSessionEpochRepository },
    { provide: AUTH_AUDIT, useClass: AuthAuditLogger },
    // Two global guards in order: authenticate (JwtAuthGuard) then authorize (RolesGuard).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
