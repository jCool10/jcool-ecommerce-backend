import { ApiProperty } from '@nestjs/swagger';
import type { AuthTokens } from '../../application/services/auth-tokens.service';

/**
 * Response for login/refresh: the token pair + access lifetime. `refreshToken`
 * is the raw opaque token (returned once). Mirrors the AuthTokens type so the
 * Swagger schema stays the contract.
 */
export class AuthTokensResponseDto implements AuthTokens {
  @ApiProperty({ description: 'Signed JWT access token (HS256).' })
  accessToken!: string;

  @ApiProperty({ description: 'Opaque refresh token — send to /auth/refresh.' })
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds.' })
  expiresIn!: number;
}
