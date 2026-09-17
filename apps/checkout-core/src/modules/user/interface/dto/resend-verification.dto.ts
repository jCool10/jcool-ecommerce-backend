import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ResendVerificationDto {
  @ApiProperty({ example: 'user@example.com', format: 'email' })
  @IsEmail()
  email!: string;
}
