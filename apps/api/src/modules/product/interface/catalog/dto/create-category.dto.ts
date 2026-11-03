import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsSnowflakeId } from '@jcool/platform/interface';
import { NoNullByte } from './no-null-byte.decorator';

// Shared by category and product slugs; uniqueness is enforced by the DB, not by this pattern.
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MESSAGE = 'slug must be lowercase alphanumeric with single hyphens (e.g. "wireless-headphones")';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Electronics', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoNullByte()
  name!: string;

  @ApiProperty({ example: 'electronics', description: 'URL-safe unique slug' })
  @IsString()
  @MaxLength(140)
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug!: string;

  @ApiPropertyOptional({ example: '137465797020397179', description: 'Parent category id for nesting' })
  @IsOptional()
  @IsSnowflakeId()
  parentId?: string;
}
