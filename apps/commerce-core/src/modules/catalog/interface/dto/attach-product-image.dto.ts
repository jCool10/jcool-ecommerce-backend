import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

// A display slot, not the int4 ceiling `product_images.position` could hold: an omitted position is
// derived as `max(position) + 1`, so a slot at the column's own limit would overflow on the next
// attach — the Postgres 22003 the filter masks as a 500 — with nothing the caller could do about it.
const MAX_POSITION = 10_000;

/** The asset must already be uploaded (READY) via `POST /admin/media/uploads`; this only records where it belongs. */
export class AttachProductImageDto {
  @ApiProperty({ description: 'Media asset id from a completed upload' })
  @IsUUID()
  assetId!: string;

  @ApiPropertyOptional({
    description: 'Display slot; appended after the last image when omitted',
    minimum: 0,
    maximum: MAX_POSITION,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_POSITION)
  position?: number;

  @ApiPropertyOptional({ description: 'Alternative text', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  alt?: string;
}

/** The list must name every image on the product exactly once, so none is left at a stale position. */
export class ReorderProductImagesDto {
  @ApiProperty({ type: [String], description: 'Image ids in the desired display order' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  imageIds!: string[];
}
