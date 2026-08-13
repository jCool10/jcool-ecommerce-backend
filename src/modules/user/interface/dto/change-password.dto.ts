import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /auth/change-password; `newPassword` follows the register bounds (8–72). */
export class ChangePasswordDto {
  @ApiProperty({ example: 'old correct horse battery staple', maxLength: 72 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  currentPassword!: string;

  @ApiProperty({ example: 'new correct horse battery staple', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
