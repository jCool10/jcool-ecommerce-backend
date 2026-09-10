import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ example: 'r9Xk3...base64url', description: 'Raw email-verification token.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;
}
