import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Query params for GET /products. `pageSize` is capped so a caller can't request
// a full-table dump.
export class ListProductsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: 'Page (1-based)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Items per page (max 100)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @ApiPropertyOptional({ description: 'Filter by category slug' })
  @IsOptional()
  @IsString()
  categorySlug?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Search product name (case-insensitive contains)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
