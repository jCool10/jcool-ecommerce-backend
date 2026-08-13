import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /auth/reset-password; `token` is the raw single-use token, `password` follows register bounds (8–72). */
export class ResetPasswordDto {
  @ApiProperty({ example: 'r9Xk3...base64url', description: 'Raw password-reset token.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;

  @ApiProperty({ example: 'correct horse battery staple', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
