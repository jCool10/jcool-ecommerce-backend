import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /auth/refresh and /auth/logout — shape only; the use case
 * decides validity with a generic 401. `MaxLength` bounds input (real token ~64 chars).
 */
export class RefreshTokenDto {
  @ApiProperty({ description: 'Opaque refresh token issued by /auth/login or /auth/refresh.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refreshToken!: string;
}
