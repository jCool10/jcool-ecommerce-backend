import { vi } from 'vitest';
import type { ObjectStoragePort } from '@shared/infrastructure/storage/object-storage.port';
import type { MediaAssetRepositoryPort } from '../application/ports/media-asset-repository.port';

/**
 * Whole-port doubles for Media's two outbound seams. `ObjectStoragePort` is shared, but every spec
 * that fakes it is a Media spec, so its double lives here.
 *
 * Every method is present so a spec passes a real port instead of casting a partial, a cast that
 * keeps compiling once the use case starts calling a second method and then fails at runtime.
 */
export function fakeMediaAssetRepository(overrides: Partial<MediaAssetRepositoryPort> = {}): MediaAssetRepositoryPort {
  return {
    insertPending: vi.fn(),
    findById: vi.fn(),
    markReady: vi.fn(),
    claimForSweep: vi.fn(),
    deleteClaimed: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    findStorageKeys: vi.fn(),
    ...overrides,
  };
}

export function fakeObjectStorage(overrides: Partial<ObjectStoragePort> = {}): ObjectStoragePort {
  return {
    presignPut: vi.fn(),
    head: vi.fn(),
    delete: vi.fn(),
    publicUrl: vi.fn(),
    ...overrides,
  };
}
