import { ApiProperty } from '@nestjs/swagger';

/**
 * Response for login/refresh: the access token + its lifetime. The refresh token
 * is NOT in the body (Phase 2) — it's delivered only in an httpOnly cookie, so it
 * can't be read by JS. Client holds the access token in memory and sends it as a
 * Bearer header.
 */
export class AuthTokensResponseDto {
  @ApiProperty({ description: 'Signed JWT access token (HS256).' })
  accessToken!: string;

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds.' })
  expiresIn!: number;
}
