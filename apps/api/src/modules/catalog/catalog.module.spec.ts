import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import {
  CATALOG_ADMIN_REPOSITORY,
  CATALOG_SEARCH,
  PRODUCT_REPOSITORY,
  PRODUCT_SOURCE_REPOSITORY,
} from './application/ports';
import { CatalogAdminService } from './application/services/catalog-admin.service';
import { CatalogModule } from './catalog.module';
import { CachingProductRepository, DrizzleProductRepository } from './infrastructure';
import { fakeCatalogSearch, fakeProductRepository } from './testing/catalog-port.doubles';

interface ProviderEntry {
  provide?: unknown;
  useClass?: unknown;
  useExisting?: unknown;
}

function boundTo(token: symbol): unknown {
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CatalogModule) ?? []) as ProviderEntry[];
  const entry = providers.find((provider) => typeof provider === 'object' && provider.provide === token);
  return entry?.useExisting ?? entry?.useClass;
}

describe('CatalogModule', () => {
  // The search document is re-derived right after a write commits. A cached read could answer from
  // a generation whose invalidation has not landed yet and index the state the write replaced.
  it('feeds the admin search sync from the uncached repository', async () => {
    const sourceRead = vi.fn().mockResolvedValue(null);
    const cachedRead = vi.fn().mockResolvedValue(null);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogAdminService,
        { provide: CATALOG_ADMIN_REPOSITORY, useValue: { archiveProduct: vi.fn().mockResolvedValue({ id: 'prod1' }) } },
        { provide: CATALOG_SEARCH, useValue: fakeCatalogSearch() },
        { provide: PRODUCT_REPOSITORY, useValue: fakeProductRepository({ findActiveByIdOrSlug: cachedRead }) },
        { provide: PRODUCT_SOURCE_REPOSITORY, useValue: fakeProductRepository({ findActiveByIdOrSlug: sourceRead }) },
        { provide: PinoLogger, useFactory: () => fakePinoLogger() },
      ],
    }).compile();

    await moduleRef.get(CatalogAdminService).archiveProduct('prod1');

    expect(boundTo(PRODUCT_SOURCE_REPOSITORY)).toBe(DrizzleProductRepository);
    expect(boundTo(PRODUCT_REPOSITORY)).toBe(CachingProductRepository);
    expect(sourceRead).toHaveBeenCalledWith('prod1');
    expect(cachedRead).not.toHaveBeenCalled();
  });
});
