import { ApiProperty } from '@nestjs/swagger';

/** The refresh token is deliberately absent: it travels only in an httpOnly cookie, unreadable by JS. */
export class AuthTokensResponseDto {
  @ApiProperty({ description: 'Signed JWT access token (HS256).' })
  accessToken!: string;

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds.' })
  expiresIn!: number;
}
