import { GoneException, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
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
  MailerAdapter,
  RedisTokenDenylist,
} from './infrastructure';
import { AuthController } from './interface/auth.controller';
import { IdentityModule } from '@shared/identity/identity.module';
import { MailModule } from '@jcool/platform/mail';
import { AuthCookieService, CsrfGuard, CsrfTokenService } from './interface/security';
import { UserModule } from './user.module';

@Module({
  imports: [
    UserModule,
    // Load-bearing despite UserModule's own import: the three token repositories are provided here
    // and each mints its own row ids.
    IdentityModule,
    MailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtAccessSecret'),
        // Numeric seconds, so every TTL in the app is parsed by the same duration helper.
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
    AuthCookieService,
    CsrfTokenService,
    CsrfGuard,
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: DrizzleRefreshTokenRepository },
    { provide: EMAIL_VERIFICATION_TOKEN_REPOSITORY, useClass: DrizzleEmailVerificationTokenRepository },
    { provide: PASSWORD_RESET_TOKEN_REPOSITORY, useClass: DrizzlePasswordResetTokenRepository },
    { provide: MAILER, useClass: MailerAdapter },
    // Writable, for the flows that revoke. The token guard reads through SessionStateModule instead.
    { provide: TOKEN_DENYLIST, useClass: RedisTokenDenylist },
    { provide: SESSION_EPOCH, useClass: DrizzleSessionEpochRepository },
    { provide: AUTH_AUDIT, useClass: AuthAuditLogger },
  ],
})
export class AuthModule implements NestModule {
  constructor(private readonly config: ConfigService) {}

  // Middleware, not a guard: it answers before the token guard, so a stale client gets 410 rather than 401.
  configure(consumer: MiddlewareConsumer): void {
    if (this.config.getOrThrow<boolean>('auth.routesEnabled')) return;
    consumer
      .apply(() => {
        throw new GoneException('Authentication has moved to the user service');
      })
      .forRoutes(AuthController);
  }
}
