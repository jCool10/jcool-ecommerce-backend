import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  LOGIN_THROTTLE,
  REFRESH_THROTTLE,
  REGISTER_THROTTLE,
} from '../../../shared/infrastructure/throttler/throttler.constants';
import { GetProfileUseCase } from '../application/use-cases/get-profile.use-case';
import { LoginUserUseCase } from '../application/use-cases/login-user.use-case';
import { LogoutUserUseCase } from '../application/use-cases/logout-user.use-case';
import { RefreshTokensUseCase } from '../application/use-cases/refresh-tokens.use-case';
import { RegisterUserUseCase } from '../application/use-cases/register-user.use-case';
import { CurrentUser, type AuthenticatedUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { RefreshTokenCookie } from './decorators/refresh-token-cookie.decorator';
import { AuthTokensResponseDto } from './dto/auth-tokens.response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { AuthCookieService } from './security/auth-cookie.service';
import { CsrfGuard } from './security/csrf.guard';

/**
 * Auth endpoints. Thin: validate DTO, call a use case, map to a response DTO.
 * Register/login/refresh are `@Public()` (each carries its own credential);
 * `/auth/me` and `/auth/logout` are protected by the global JwtAuthGuard.
 *
 * Token delivery (Phase 2): the access token is returned in the JSON body (the
 * client holds it in memory and sends it as a Bearer header — CSRF-immune). The
 * refresh token travels only in an httpOnly Secure SameSite cookie, so the
 * cookie-authenticated routes (refresh/logout) carry a double-submit CSRF token.
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
  ) {}

  @Public()
  @Post('register')
  @Throttle(REGISTER_THROTTLE)
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiConflictResponse({ description: 'Email already registered' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async register(@Body() dto: RegisterDto): Promise<UserResponseDto> {
    const user = await this.registerUser.execute({ email: dto.email, password: dto.password });
    return UserResponseDto.fromEntity(user);
  }

  @Public()
  @Post('login')
  @Throttle(LOGIN_THROTTLE)
  @HttpCode(HttpStatus.OK) // POST defaults to 201; login is not a creation.
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<AuthTokensResponseDto> {
    const tokens = await this.loginUser.execute({ email: dto.email, password: dto.password });
    this.authCookies.setSession(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid token' })
  async me(@CurrentUser() current: AuthenticatedUser): Promise<UserResponseDto> {
    const user = await this.getProfile.execute(current.userId);
    return UserResponseDto.fromEntity(user);
  }

  @Public() // carries its own credential (the refresh cookie) — no access token needed.
  @Post('refresh')
  @UseGuards(CsrfGuard)
  @Throttle(REFRESH_THROTTLE)
  @HttpCode(HttpStatus.OK) // POST defaults to 201; refresh returns, not creates.
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid, expired, revoked, or reused refresh token' })
  @ApiForbiddenResponse({ description: 'Missing or invalid CSRF token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async refresh(
    @RefreshTokenCookie() refreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensResponseDto> {
    // No cookie → generic 401, same message the use case uses for a bad token.
    if (!refreshToken) throw new UnauthorizedException('Invalid refresh token');

    const tokens = await this.refreshTokens.execute(refreshToken);
    this.authCookies.setSession(res, tokens.refreshToken);
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
  ): Promise<void> {
    await this.logoutUser.execute({
      userId: current.userId,
      accessJti: current.jti,
      accessExp: current.exp,
      // No cookie is a no-op revoke; the access jti is still denylisted below.
      rawRefreshToken: refreshToken ?? '',
    });
    this.authCookies.clear(res);
  }
}
