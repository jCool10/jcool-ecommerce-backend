import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

export class SetPriceDto {
  @ApiProperty({ example: 2490000, minimum: 0, description: 'Amount in minor units (integer)' })
  @IsInt()
  @Min(0)
  amountMinor!: number;

  @ApiPropertyOptional({ example: 'VND', default: 'VND', description: 'ISO-4217 code (3 uppercase letters)' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter uppercase ISO-4217 code' })
  currency?: string;
}
