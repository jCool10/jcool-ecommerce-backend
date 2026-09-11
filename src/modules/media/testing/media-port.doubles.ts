import { vi } from 'vitest';
import type { ObjectStoragePort } from '@shared/infrastructure/storage/object-storage.port';
import type { MediaAssetRepositoryPort } from '../application/ports/media-asset-repository.port';

/**
 * Whole-port doubles for Media's two outbound seams. `ObjectStoragePort` is shared, but its double
 * belongs next to the specs that use it — every one of them is a Media spec, and the four of them
 * had four different one-method literals cast to the port.
 *
 * Every method is present so the spec passes a real port instead of casting a partial — a cast that
 * keeps compiling once the use case starts calling a second method, then fails at runtime.
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
