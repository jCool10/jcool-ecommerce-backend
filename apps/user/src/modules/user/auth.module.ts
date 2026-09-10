import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthVerifyModule } from '@shared/auth';
import { durationToMs } from './application';
import {
  AUTH_AUDIT,
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  MAILER,
  PASSWORD_RESET_TOKEN_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_EPOCH,
  SESSION_EPOCH_PROJECTION,
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
  MailerAdapter,
  RedisSessionEpochProjection,
} from './infrastructure';
import { AuthController } from './interface/auth.controller';
import { IdentityModule } from '@shared/identity/identity.module';
import { MailModule } from '@shared/mail';
import { AuthCookieService, CsrfGuard, CsrfTokenService } from './interface/security';
import { UserModule } from './user.module';

@Module({
  imports: [
    UserModule,
    // Load-bearing despite UserModule's own import: the three token repositories are provided here
    // and each mints its own row ids.
    IdentityModule,
    MailModule,
    // Supplies the denylist this module's logout writes to, and mounts the global auth guards.
    AuthVerifyModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        privateKey: config.getOrThrow<string>('auth.jwtPrivateKey'),
        signOptions: {
          algorithm: 'ES256' as const,
          keyid: config.getOrThrow<string>('auth.jwtKeyId'),
          // Numeric seconds, so every TTL in the app is parsed by the same duration helper.
          expiresIn: Math.floor(durationToMs(config.getOrThrow<string>('auth.jwtAccessTtl')) / 1000),
        },
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
    AuthCookieService,
    CsrfTokenService,
    CsrfGuard,
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: DrizzleRefreshTokenRepository },
    { provide: EMAIL_VERIFICATION_TOKEN_REPOSITORY, useClass: DrizzleEmailVerificationTokenRepository },
    { provide: PASSWORD_RESET_TOKEN_REPOSITORY, useClass: DrizzlePasswordResetTokenRepository },
    { provide: MAILER, useClass: MailerAdapter },
    { provide: SESSION_EPOCH, useClass: DrizzleSessionEpochRepository },
    { provide: SESSION_EPOCH_PROJECTION, useClass: RedisSessionEpochProjection },
    { provide: AUTH_AUDIT, useClass: AuthAuditLogger },
  ],
})
export class AuthModule {}
