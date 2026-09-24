import { describe, expect, it } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { fakeMediaAssetRepository, fakeObjectStorage } from '../../testing/media-port.doubles';
import { InitiateUploadUseCase } from './initiate-upload.use-case';

const UPLOAD_TTL_SEC = 3600;

function build(presignTtlSec: number, calls: string[] = []): InitiateUploadUseCase {
  return new InitiateUploadUseCase(
    fakeMediaAssetRepository({
      insertPending: () => {
        calls.push('insert');
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
    fakeConfigService({ 'storage.presignTtlSec': presignTtlSec, 'media.uploadTtlSec': UPLOAD_TTL_SEC }),
    fakePinoLogger(),
  );
}

describe('InitiateUploadUseCase', () => {
  // The reverse order would leave bucket objects that no row, and so no sweep, knows about.
  it('writes the PENDING row before signing the upload URL', async () => {
    const calls: string[] = [];

    await build(900, calls).execute({ contentType: 'image/png', uploadedBy: 'admin-1' });

    expect(calls).toEqual(['insert', 'presign']);
  });

  it('refuses to start unless the upload URL expires before the row does', () => {
    expect(() => build(UPLOAD_TTL_SEC)).toThrow(/STORAGE_PRESIGN_TTL_SEC/);
    expect(() => build(UPLOAD_TTL_SEC - 1)).not.toThrow();
  });
});
