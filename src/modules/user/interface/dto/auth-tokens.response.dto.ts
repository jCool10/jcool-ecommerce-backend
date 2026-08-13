import { ApiProperty } from '@nestjs/swagger';

/**
 * Response for login/refresh: the access token + its lifetime. The refresh token is
 * never in the body — it's delivered only in an httpOnly cookie (unreadable by JS).
 */
export class AuthTokensResponseDto {
  @ApiProperty({ description: 'Signed JWT access token (HS256).' })
  accessToken!: string;

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds.' })
  expiresIn!: number;
}
