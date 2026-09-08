import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type AuthenticatedUser, CurrentUser, Role, Roles } from '@shared/rbac';
import { UnsupportedContentTypeError } from '../domain/asset-content-type';
import { AssetTransitionError } from '../domain/asset-state-machine';
import { MediaAssetNotFoundError } from '../domain/errors/media-asset-not-found.error';
import { UploadRejectedError } from '../domain/errors/upload-rejected.error';
import { CompleteUploadUseCase } from '../application/use-cases/complete-upload.use-case';
import { InitiateUploadUseCase } from '../application/use-cases/initiate-upload.use-case';
import { InitiateUploadDto, UploadTicketResponseDto } from './dto';

/**
 * Domain failures carry no HTTP status, and the global filter answers 500 for anything that is not
 * an `HttpException` — so the translation happens here, at the one boundary that knows about status
 * codes. A rejected upload and an asset that already moved on are both "the state is not what you
 * assumed", hence 409 for both.
 */
function asHttp(error: unknown): never {
  if (error instanceof UnsupportedContentTypeError) throw new BadRequestException(error.message);
  if (error instanceof MediaAssetNotFoundError) throw new NotFoundException(error.message);
  if (error instanceof UploadRejectedError || error instanceof AssetTransitionError) {
    throw new ConflictException(error.message);
  }
  throw error;
}

/**
 * The upload handshake, in two calls. Between them the client talks to the bucket, not to us — this
 * process never holds a byte of the file, so a large upload costs it no memory and no request slot.
 *
 * Admin-only. Anyone who can ask for a signed URL can write to the bucket for as long as it lasts,
 * which is what bounds the abuse a presigned PUT would otherwise invite.
 */
@ApiTags('admin-media')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@ApiForbiddenResponse({ description: 'Authenticated but not an admin' })
@Roles(Role.Admin)
@Controller('admin/media')
export class MediaController {
  constructor(
    private readonly initiate: InitiateUploadUseCase,
    private readonly complete: CompleteUploadUseCase,
  ) {}

  @Post('uploads')
  @ApiCreatedResponse({ type: UploadTicketResponseDto })
  @ApiBadRequestResponse({ description: 'Content type is outside the image allowlist' })
  async initiateUpload(
    @Body() dto: InitiateUploadDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UploadTicketResponseDto> {
    try {
      return UploadTicketResponseDto.from(
        await this.initiate.execute({ contentType: dto.contentType, uploadedBy: user.userId }),
      );
    } catch (error) {
      asHttp(error);
    }
  }

  @Post('uploads/:assetId/complete')
  // Nothing to return: the asset id the caller already holds is the whole result, and the object
  // itself is not ours to describe.
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'assetId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'The upload is confirmed and the asset can now be attached' })
  @ApiNotFoundResponse({ description: 'No such asset' })
  @ApiConflictResponse({
    description: 'Nothing was uploaded, the object is over the size limit, or the asset has already moved on',
  })
  async completeUpload(@Param('assetId', ParseUUIDPipe) assetId: string): Promise<void> {
    try {
      await this.complete.execute(assetId);
    } catch (error) {
      asHttp(error);
    }
  }
}
