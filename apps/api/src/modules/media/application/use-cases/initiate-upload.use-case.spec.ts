import { describe, expect, it } from 'vitest';
import { bucketOf } from '@jcool/id-codec';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { RecordingIdGenerator, sampleId } from '@shared/testing/id-generator.double';
import type { MediaAsset } from '../../domain/media-asset.entity';
import { fakeMediaAssetRepository, fakeObjectStorage } from '../../testing/media-port.doubles';
import { InitiateUploadUseCase } from './initiate-upload.use-case';

const UPLOAD_TTL_SEC = 3600;
const ADMIN_ID = sampleId(0, 42);

function build(presignTtlSec: number, calls: string[] = [], inserted: MediaAsset[] = []): InitiateUploadUseCase {
  return new InitiateUploadUseCase(
    fakeMediaAssetRepository({
      insertPending: (asset) => {
        calls.push('insert');
        inserted.push(asset);
        return Promise.resolve();
      },
    }),
    fakeObjectStorage({
      presignPut: (_key, contentType) => {
        calls.push('presign');
        return Promise.resolve({
          url: 'https://bucket.example/put',
          headers: { 'Content-Type': contentType },
          expiresInSec: 900,
        });
      },
    }),
    new RecordingIdGenerator(),
    fakeConfigService({ 'storage.presignTtlSec': presignTtlSec, 'media.uploadTtlSec': UPLOAD_TTL_SEC }),
    fakePinoLogger(),
  );
}

describe('InitiateUploadUseCase', () => {
  // The reverse order would leave bucket objects that no row, and so no sweep, knows about.
  it('writes the PENDING row before signing the upload URL', async () => {
    const calls: string[] = [];

    await build(900, calls).execute({ contentType: 'image/png', uploadedBy: ADMIN_ID });

    expect(calls).toEqual(['insert', 'presign']);
  });

  it('mints the asset id in the uploader bucket and keys the object by it', async () => {
    const inserted: MediaAsset[] = [];

    const { assetId } = await build(900, [], inserted).execute({ contentType: 'image/png', uploadedBy: ADMIN_ID });

    expect(bucketOf(assetId)).toBe(42);
    expect(inserted[0]?.storageKey).toBe(`media/${assetId}.png`);
  });

  it('refuses to start unless the upload URL expires before the row does', () => {
    expect(() => build(UPLOAD_TTL_SEC)).toThrow(/STORAGE_PRESIGN_TTL_SEC/);
    expect(() => build(UPLOAD_TTL_SEC - 1)).not.toThrow();
  });
});
