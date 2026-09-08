import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_ADMIN_REPOSITORY,
  CATALOG_SEARCH,
  PRODUCT_REPOSITORY,
  PRODUCT_SOURCE_REPOSITORY,
} from './application/ports';
import { CatalogAdminService } from './application/services/catalog-admin.service';
import { CatalogModule } from './catalog.module';
import { CachingProductRepository, DrizzleProductRepository } from './infrastructure';

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

/**
 * The search document is re-derived right after a write commits, so the read behind it must hit
 * Postgres: the caching adapter answers from a generation whose invalidation may not have landed
 * yet, which would index the state the write just replaced. Both halves of that wiring are asserted
 * — the token the service asks for, and the class the module binds it to.
 */
describe('CatalogModule search-sync wiring', () => {
  it('binds the product source token to the uncached repository', () => {
    expect(boundTo(PRODUCT_SOURCE_REPOSITORY)).toBe(DrizzleProductRepository);
    expect(boundTo(PRODUCT_SOURCE_REPOSITORY)).not.toBe(CachingProductRepository);
    // The public read path stays on the cached one — this is a second binding, not a swap.
    expect(boundTo(PRODUCT_REPOSITORY)).toBe(CachingProductRepository);
  });

  it('injects the product source, not the cached repository, into the admin service', async () => {
    const source = { findActiveByIdOrSlug: vi.fn().mockResolvedValue(null) };
    const cached = { findActiveByIdOrSlug: vi.fn().mockResolvedValue(null) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogAdminService,
        { provide: CATALOG_ADMIN_REPOSITORY, useValue: { archiveProduct: vi.fn().mockResolvedValue({ id: 'prod1' }) } },
        { provide: CATALOG_SEARCH, useValue: { indexProduct: vi.fn(), deleteProduct: vi.fn() } },
        { provide: PRODUCT_REPOSITORY, useValue: cached },
        { provide: PRODUCT_SOURCE_REPOSITORY, useValue: source },
      ],
    }).compile();

    await moduleRef.get(CatalogAdminService).archiveProduct('prod1');

    expect(source.findActiveByIdOrSlug).toHaveBeenCalledWith('prod1');
    expect(cached.findActiveByIdOrSlug).not.toHaveBeenCalled();
  });
});
