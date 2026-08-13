import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/** Body for POST /auth/forgot-password — only the email is needed, and the endpoint always returns the same generic response so the address is never confirmed. */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com', format: 'email' })
  @IsEmail()
  email!: string;
}
