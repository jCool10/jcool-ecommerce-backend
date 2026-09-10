import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

// `prices.amount_minor` is int4: capping at the column's own ceiling turns an out-of-range price
// into a 400 with a field message instead of a Postgres 22003 masked as a 500.
const MAX_AMOUNT_MINOR = 2_147_483_647;

export class SetPriceDto {
  @ApiProperty({
    example: 2490000,
    minimum: 0,
    maximum: MAX_AMOUNT_MINOR,
    description: 'Amount in minor units (integer)',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT_MINOR)
  amountMinor!: number;

  @ApiPropertyOptional({ example: 'VND', default: 'VND', description: 'ISO-4217 code (3 uppercase letters)' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter uppercase ISO-4217 code' })
  currency?: string;
}
