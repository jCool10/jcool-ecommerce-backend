import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SLUG_MESSAGE, SLUG_PATTERN } from './create-category.dto';

// `q` is required, unlike the list endpoint's optional substring filter: a relevance search with no
// terms has nothing to rank by. `categorySlug` is pinned to the slug shape because it reaches the
// engine inside a filter expression — the adapter escapes it as well, so neither layer stands alone.
export class SearchProductsQueryDto {
  @ApiProperty({
    maxLength: 100,
    example: 'wireless headphones',
    description: 'Search terms; typo-tolerant and relevance-ranked',
  })
  // Trimmed before validation so an all-whitespace query fails IsNotEmpty rather than reaching the
  // engine as a term that matches nothing.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  q!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10_000,
    default: 1,
    description: 'Page (1-based, max 10000)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
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
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  categorySlug?: string;
}
