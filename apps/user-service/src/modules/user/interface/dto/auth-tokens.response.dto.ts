import { ApiProperty } from '@nestjs/swagger';

/** The refresh token is deliberately absent: it travels only in an httpOnly cookie, unreadable by JS. */
export class AuthTokensResponseDto {
  @ApiProperty({ description: 'Signed JWT access token (ES256).' })
  accessToken!: string;

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds.' })
  expiresIn!: number;

  @ApiProperty({
    description:
      'CSRF token, the same value as the `csrf_token` cookie. Send it back as the `x-csrf-token` header on `/auth/refresh` and `/auth/logout`; the cookie (Path=/auth) is not readable by a page elsewhere.',
  })
  csrfToken!: string;
}
