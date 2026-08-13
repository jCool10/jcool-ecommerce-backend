import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /auth/verify-email. `token` is the raw single-use token from the
 * verification email; MaxLength caps input to guard against oversized payloads.
 */
export class VerifyEmailDto {
  @ApiProperty({ example: 'r9Xk3...base64url', description: 'Raw email-verification token.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;
}
