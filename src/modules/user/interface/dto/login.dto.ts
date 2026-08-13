import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body for POST /auth/login — shape only (the use case decides correctness with a generic 401); `MaxLength(72)` mirrors RegisterDto to reject oversized input before argon2 runs. */
export class LoginDto {
  @ApiProperty({ example: 'user@example.com', format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple', maxLength: 72 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password!: string;
}
