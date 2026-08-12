import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for POST /auth/register. `password` is bounded MinLength(8) for a
 * baseline and MaxLength(72) to cap the argon2 input (DoS guard).
 */
export class RegisterDto {
  @ApiProperty({ example: 'user@example.com', format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
