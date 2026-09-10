import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SearchHit } from '../../application/ports';

// The matched text with `<em>` around the match, straight from the engine. A client rendering it as
// HTML must escape everything but those tags, since the surrounding text is admin-authored content.
export class SearchHighlightDto {
  @ApiPropertyOptional({ example: 'Wireless <em>Headphones</em>' })
  name?: string;

  @ApiPropertyOptional()
  description?: string;
}

export class SearchHitDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  categorySlug!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Lowest price in minor units (int)' })
  minPriceMinor!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'VND' })
  currency!: string | null;

  @ApiPropertyOptional({ type: SearchHighlightDto })
  highlight?: SearchHighlightDto;

  static fromHit(hit: SearchHit): SearchHitDto {
    const dto = new SearchHitDto();
    dto.id = hit.id;
    dto.name = hit.name;
    dto.slug = hit.slug;
    dto.categorySlug = hit.categorySlug;
    dto.minPriceMinor = hit.minPriceMinor;
    dto.currency = hit.currency;
    dto.highlight = hit.highlight;
    return dto;
  }
}

export class ProductSearchResponseDto {
  @ApiProperty({ type: [SearchHitDto] })
  items!: SearchHitDto[];

  @ApiProperty({
    example: 42,
    description:
      'Matches reachable by paging, estimated by the engine and capped at its paging depth — not an exact count like GET /products',
  })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
