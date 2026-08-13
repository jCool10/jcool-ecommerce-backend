import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/**
 * Body for POST /auth/resend-verification. Only the email is needed; the endpoint
 * always returns the same generic response, so the address is never confirmed.
 */
export class ResendVerificationDto {
  @ApiProperty({ example: 'user@example.com', format: 'email' })
  @IsEmail()
  email!: string;
}
