import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

/** The asset must already be uploaded (READY) via `POST /admin/media/uploads`; this only records where it belongs. */
export class AttachProductImageDto {
  @ApiProperty({ description: 'Media asset id from a completed upload' })
  @IsUUID()
  assetId!: string;

  @ApiPropertyOptional({ description: 'Display slot; appended after the last image when omitted', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
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
