import { ApiProperty } from '@nestjs/swagger';
import type { InitiateUploadResult } from '../../application/use-cases/initiate-upload.use-case';

export class UploadTicketResponseDto {
  @ApiProperty({ format: 'uuid' })
  assetId!: string;

  @ApiProperty({ description: 'PUT the bytes here directly. They never pass through this API.' })
  uploadUrl!: string;

  @ApiProperty({
    description: 'Send these headers verbatim — they are covered by the signature, so any other value is refused.',
    example: { 'Content-Type': 'image/webp' },
  })
  headers!: Record<string, string>;

  @ApiProperty({ description: 'Seconds the URL stays valid.' })
  expiresInSec!: number;

  static from(result: InitiateUploadResult): UploadTicketResponseDto {
    return { ...result };
  }
}
