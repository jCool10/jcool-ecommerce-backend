import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { durationToMs } from './application';
import {
  AUTH_AUDIT,
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  MAILER,
  PASSWORD_RESET_TOKEN_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_EPOCH,
  TOKEN_DENYLIST,
} from './application/ports';
import {
  AuthTokensService,
  EmailVerificationService,
  PasswordResetService,
  SessionService,
  SweepAuthTokensService,
} from './application/services';
import {
  ChangePasswordUseCase,
  ForgotPasswordUseCase,
  GetProfileUseCase,
  LoginUserUseCase,
  LogoutUserUseCase,
  RefreshTokensUseCase,
  RegisterUserUseCase,
  ResendVerificationUseCase,
} from './application/use-cases';
import {
  AuthAuditLogger,
  DrizzleEmailVerificationTokenRepository,
  DrizzlePasswordResetTokenRepository,
  DrizzleRefreshTokenRepository,
  DrizzleSessionEpochRepository,
  LogMailer,
  RedisTokenDenylist,
} from './infrastructure';
import { AuthController } from './interface/auth.controller';
import { JwtAuthGuard } from './interface/guards/jwt-auth.guard';
import { IdentityModule } from '@shared/identity/identity.module';
import { RolesGuard } from '@shared/rbac';
import { AuthCookieService, CsrfGuard, CsrfTokenService } from './interface/security';
import { JwtStrategy } from './interface/strategies/jwt.strategy';
import { UserModule } from './user.module';

/** Auth surface for the User context — register/login, token issuance + rotation, and the two global guards (JwtAuthGuard then RolesGuard); imports UserModule for its ports and configures JwtModule (HS256). */
@Module({
  imports: [
    UserModule,
    // Load-bearing despite UserModule's own import: the three token repositories are provided here
    // and each mints its own row ids.
    IdentityModule,
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
    // Provided here rather than in UserModule because the three token repositories are: it registers
    // three sweeps with the shared retention registry on init, one per table.
    SweepAuthTokensService,
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
