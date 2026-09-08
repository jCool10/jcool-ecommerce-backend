import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SLUG_MESSAGE, SLUG_PATTERN } from './create-category.dto';

// Every field here is part of the read cache's key fingerprint, so an unbounded field is an
// unbounded number of cache keys as well as an unbounded query.
export class ListProductsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10_000,
    default: 1,
    description: 'Page (1-based, max 10000)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Deep pages are the expensive kind: OFFSET makes Postgres walk and discard every skipped
  // row, and each distinct page mints its own cache key. 10k pages × the 100-item cap is far
  // past any real catalog, so the ceiling costs no reachable data.
  @Max(10_000)
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
  // Same shape the slug was created with: anything else can never match a row, so rejecting it
  // is both a clearer answer than an empty page and one less way to mint junk cache keys.
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
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
