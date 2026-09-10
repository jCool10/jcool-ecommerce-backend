import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { LOGIN_THROTTLE, REFRESH_THROTTLE, REGISTER_THROTTLE } from '@shared/infrastructure/throttler';
import { AUTH_AUDIT, type AuthAuditPort } from '../application/ports';
import { EmailVerificationService, PasswordResetService, SessionService } from '../application/services';
import {
  ChangePasswordUseCase,
  ForgotPasswordUseCase,
  GetProfileUseCase,
  LoginUserUseCase,
  LogoutUserUseCase,
  RefreshTokensUseCase,
  RegisterUserUseCase,
  ResendVerificationUseCase,
} from '../application/use-cases';
import { CurrentUser, Public, type AuthenticatedUser } from '@shared/rbac';
import { RefreshTokenCookie } from './decorators';
import {
  AuthTokensResponseDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SessionResponseDto,
  UserResponseDto,
  VerifyEmailDto,
} from './dto';
import { AuthCookieService, CsrfGuard } from './security';

/**
 * The access token travels in the JSON body (Bearer, so CSRF-immune); the refresh token lives only
 * in an httpOnly cookie, which is why the cookie-driven routes add a CSRF guard.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUserUseCase,
    private readonly loginUser: LoginUserUseCase,
    private readonly getProfile: GetProfileUseCase,
    private readonly refreshTokens: RefreshTokensUseCase,
    private readonly logoutUser: LogoutUserUseCase,
    private readonly authCookies: AuthCookieService,
    @Inject(AUTH_AUDIT) private readonly audit: AuthAuditPort,
    private readonly emailVerification: EmailVerificationService,
    private readonly resendVerification: ResendVerificationUseCase,
    private readonly passwordReset: PasswordResetService,
    private readonly forgotPassword: ForgotPasswordUseCase,
    private readonly changePassword: ChangePasswordUseCase,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('register')
  @Throttle(REGISTER_THROTTLE)
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiConflictResponse({ description: 'Email already registered' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async register(
    @Body() dto: RegisterDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<UserResponseDto> {
    const user = await this.registerUser.execute({ email: dto.email, password: dto.password });
    this.audit.record({
      event: 'user.registered',
      outcome: 'success',
      userId: user.id,
      email: user.email,
      ip,
      userAgent,
    });
    return UserResponseDto.fromEntity(user);
  }

  @Public() // carries its own credential (the raw token) — no session needed.
  @Post('verify-email')
  @Throttle(REFRESH_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Email verified' })
  @ApiBadRequestResponse({ description: 'Invalid or expired verification token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    const { userId } = await this.emailVerification.verify(dto.token);
    this.audit.record({ event: 'email.verified', outcome: 'success', userId, ip, userAgent });
  }

  @Public()
  @Post('resend-verification')
  @Throttle(REGISTER_THROTTLE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ description: 'If the address needs verification, an email has been sent' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async resendVerificationEmail(@Body() dto: ResendVerificationDto): Promise<void> {
    // Enumeration-safe: always 202, whether or not a mail was actually dispatched.
    await this.resendVerification.execute(dto.email);
  }

  @Public()
  @Post('forgot-password')
  @Throttle(REGISTER_THROTTLE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ description: 'If the address has an account, a reset email has been sent' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async forgotPasswordRequest(@Body() dto: ForgotPasswordDto): Promise<void> {
    // Enumeration-safe: always 202, whether or not a mail was actually dispatched.
    await this.forgotPassword.execute(dto.email);
  }

  @Public() // carries its own credential (the raw token) — no session needed.
  @Post('reset-password')
  @Throttle(REFRESH_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Password reset — all sessions revoked' })
  @ApiBadRequestResponse({ description: 'Invalid or expired password-reset token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    const { userId } = await this.passwordReset.reset(dto.token, dto.password);
    this.audit.record({ event: 'password.reset', outcome: 'success', userId, ip, userAgent });
  }

  @Public()
  @Post('login')
  @Throttle(LOGIN_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  @ApiForbiddenResponse({ description: 'Email not verified (when verification is enforced)' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthTokensResponseDto> {
    try {
      const tokens = await this.loginUser.execute({ email: dto.email, password: dto.password });
      this.authCookies.setSession(res, tokens.refreshToken);
      this.audit.record({ event: 'login.succeeded', outcome: 'success', email: dto.email, ip, userAgent });
      return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
    } catch (error) {
      // Audited as a brute-force signal, then rethrown unchanged so the response reveals nothing beyond status.
      this.audit.record({
        event: 'login.failed',
        outcome: 'failure',
        email: dto.email,
        ip,
        userAgent,
        reason: loginFailureReason(error),
      });
      throw error;
    }
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid token' })
  async me(@CurrentUser() current: AuthenticatedUser): Promise<UserResponseDto> {
    const user = await this.getProfile.execute(current.userId);
    return UserResponseDto.fromEntity(user);
  }

  // Bearer-authenticated → CSRF-immune (a browser never auto-attaches the Authorization header cross-site).
  @Post('change-password')
  @Throttle(REFRESH_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'Password changed — every session revoked, re-login required' })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid access token, or wrong current password' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async changePasswordRequest(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.changePassword.execute({
      userId: current.userId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });
    this.authCookies.clear(res);
    this.audit.record({ event: 'password.changed', outcome: 'success', userId: current.userId, ip, userAgent });
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOkResponse({ type: SessionResponseDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid token' })
  async listSessions(
    @CurrentUser() current: AuthenticatedUser,
    @RefreshTokenCookie() refreshToken: string | undefined,
  ): Promise<SessionResponseDto[]> {
    const sessions = await this.sessions.listActiveSessions(current.userId, refreshToken ?? null);
    return sessions.map((session) => SessionResponseDto.fromActive(session));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Session id (token family) from GET /auth/sessions.' })
  @ApiNoContentResponse({ description: 'Session revoked' })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid token' })
  @ApiNotFoundResponse({ description: 'No such session for this user' })
  async revokeSession(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    const revoked = await this.sessions.revokeSession(current.userId, id);
    if (!revoked) throw new NotFoundException('Session not found');
    this.audit.record({
      event: 'session.revoked',
      outcome: 'success',
      userId: current.userId,
      ip,
      userAgent,
      metadata: { sessionId: id },
    });
  }

  // Bearer-authenticated (revokes by user id, not the presented cookie) → CSRF-immune.
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'All sessions revoked (this device included)' })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, revoked, or invalid access token' })
  async logoutAll(
    @CurrentUser() current: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.sessions.revokeAll(current.userId);
    this.authCookies.clear(res);
    this.audit.record({ event: 'logout.all', outcome: 'success', userId: current.userId, ip, userAgent });
  }

  @Public() // carries its own credential (the refresh cookie) — no access token needed.
  @Post('refresh')
  @UseGuards(CsrfGuard)
  @Throttle(REFRESH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid, expired, revoked, or reused refresh token' })
  @ApiForbiddenResponse({ description: 'Missing or invalid CSRF token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async refresh(
    @RefreshTokenCookie() refreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthTokensResponseDto> {
    // No cookie → generic 401, same message the use case uses for a bad token.
    if (!refreshToken) throw new UnauthorizedException('Invalid refresh token');

    const tokens = await this.refreshTokens.execute(refreshToken);
    this.authCookies.setSession(res, tokens.refreshToken);
    this.audit.record({ event: 'token.refreshed', outcome: 'success', ip, userAgent });
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Post('logout')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'Session revoked — access token denylisted + refresh token revoked' })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, revoked, or invalid access token' })
  @ApiForbiddenResponse({ description: 'Missing or invalid CSRF token' })
  async logout(
    @CurrentUser() current: AuthenticatedUser,
    @RefreshTokenCookie() refreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.logoutUser.execute({
      userId: current.userId,
      accessJti: current.jti,
      accessExp: current.exp,
      // No cookie is a no-op revoke; the access jti is still denylisted below.
      rawRefreshToken: refreshToken ?? '',
    });
    this.authCookies.clear(res);
    this.audit.record({ event: 'logout', outcome: 'success', userId: current.userId, ip, userAgent });
  }
}

function loginFailureReason(error: unknown): string {
  if (error instanceof UnauthorizedException) return 'invalid_credentials';
  if (error instanceof ForbiddenException) return 'email_not_verified';
  return 'error';
}
