import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { ALLOWED_CONTENT_TYPES, type AllowedContentType } from '../../domain/asset-content-type';

const ALLOWED = Object.keys(ALLOWED_CONTENT_TYPES) as AllowedContentType[];

export class InitiateUploadDto {
  // No filename field, deliberately: the storage key is minted from the asset id and a server-side
  // extension table, so a client-supplied name has nowhere to go and nothing to traverse.
  @ApiProperty({ enum: ALLOWED, description: 'Content type the client will PUT. It is signed into the URL.' })
  @IsIn(ALLOWED)
  contentType!: AllowedContentType;
}
