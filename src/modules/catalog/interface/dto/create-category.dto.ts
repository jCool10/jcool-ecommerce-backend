import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

// Shared by category and product slugs; uniqueness is enforced by the DB, not by this pattern.
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MESSAGE = 'slug must be lowercase alphanumeric with single hyphens (e.g. "wireless-headphones")';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Electronics', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'electronics', description: 'URL-safe unique slug' })
  @IsString()
  @MaxLength(140)
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug!: string;

  @ApiPropertyOptional({ description: 'Parent category id (UUID v7) for nesting' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
