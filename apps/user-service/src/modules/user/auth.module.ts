import { Module } from '@nestjs/common';
import { MailModule } from '@jcool/platform/mail';
import { AccessTokenKeysModule } from './access-token-keys.module';
import {
  AUTH_AUDIT,
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  MAILER,
  PASSWORD_RESET_TOKEN_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
} from './application/ports';
import {
  AuthTokensService,
  EmailVerificationService,
  PasswordResetService,
  SessionEpochReconciler,
  SessionService,
  SweepAuthTokensService,
} from './application/services';
import {
  ChangePasswordUseCase,
  FillSessionEpochUseCase,
  ForgotPasswordUseCase,
  GetProfileUseCase,
  LoginUserUseCase,
  LogoutUserUseCase,
  RefreshTokensUseCase,
  RegisterUserUseCase,
  ResendVerificationUseCase,
} from './application/use-cases';
import { IdentityModule } from './identity.module';
import {
  AuthAuditLogger,
  DrizzleEmailVerificationTokenRepository,
  DrizzlePasswordResetTokenRepository,
  DrizzleRefreshTokenRepository,
  MailerAdapter,
} from './infrastructure';
import { AuthController } from './interface/auth.controller';
import { InternalApiController } from './interface/internal/internal-api.controller';
import { InternalApiTokenGuard } from './interface/internal/internal-api-token.guard';
import { JwksController } from './interface/jwks.controller';
import { AuthCookieService, CsrfGuard, CsrfTokenService } from './interface/security';
import { SessionEpochReconcileScheduler } from './interface/session-epoch-reconcile.scheduler';
import { SessionStateModule } from './session-state.module';
import { UserModule } from './user.module';

// The request guards come from AuthVerifierModule in the root module, which orders them after the
// throttler.
@Module({
  imports: [UserModule, IdentityModule, SessionStateModule, AccessTokenKeysModule, MailModule],
  controllers: [AuthController, JwksController, InternalApiController],
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
    // Registers one sweep per token table with the shared retention registry on init.
    SweepAuthTokensService,
    ChangePasswordUseCase,
    FillSessionEpochUseCase,
    SessionEpochReconciler,
    SessionEpochReconcileScheduler,
    AuthCookieService,
    CsrfTokenService,
    CsrfGuard,
    InternalApiTokenGuard,
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: DrizzleRefreshTokenRepository },
    { provide: EMAIL_VERIFICATION_TOKEN_REPOSITORY, useClass: DrizzleEmailVerificationTokenRepository },
    { provide: PASSWORD_RESET_TOKEN_REPOSITORY, useClass: DrizzlePasswordResetTokenRepository },
    { provide: MAILER, useClass: MailerAdapter },
    { provide: AUTH_AUDIT, useClass: AuthAuditLogger },
  ],
})
export class AuthModule {}
