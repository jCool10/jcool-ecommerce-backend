import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { GetProfileUseCase } from '../application/use-cases/get-profile.use-case';
import { LoginUserUseCase } from '../application/use-cases/login-user.use-case';
import { LogoutUserUseCase } from '../application/use-cases/logout-user.use-case';
import { RefreshTokensUseCase } from '../application/use-cases/refresh-tokens.use-case';
import { RegisterUserUseCase } from '../application/use-cases/register-user.use-case';
import { CurrentUser, type AuthenticatedUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { AuthTokensResponseDto } from './dto/auth-tokens.response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from './dto/user-response.dto';

/**
 * Auth endpoints. Thin: validate DTO, call a use case, map to a response DTO.
 * Register/login/refresh are `@Public()` (each carries its own credential);
 * `/auth/me` and `/auth/logout` are protected by the global JwtAuthGuard.
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
  ) {}

  @Public()
  @Post('register')
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiConflictResponse({ description: 'Email already registered' })
  async register(@Body() dto: RegisterDto): Promise<UserResponseDto> {
    const user = await this.registerUser.execute({ email: dto.email, password: dto.password });
    return UserResponseDto.fromEntity(user);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK) // POST defaults to 201; login is not a creation.
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto): Promise<AuthTokensResponseDto> {
    return this.loginUser.execute({ email: dto.email, password: dto.password });
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid token' })
  async me(@CurrentUser() current: AuthenticatedUser): Promise<UserResponseDto> {
    const user = await this.getProfile.execute(current.userId);
    return UserResponseDto.fromEntity(user);
  }

  @Public() // carries its own credential (the refresh token) — no access token needed.
  @Post('refresh')
  @HttpCode(HttpStatus.OK) // POST defaults to 201; refresh returns, not creates.
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid, expired, revoked, or reused refresh token' })
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokensResponseDto> {
    return this.refreshTokens.execute(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'Session revoked (idempotent — always 204)' })
  @ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
  async logout(@CurrentUser() current: AuthenticatedUser, @Body() dto: RefreshTokenDto): Promise<void> {
    await this.logoutUser.execute(current.userId, dto.refreshToken);
  }
}
