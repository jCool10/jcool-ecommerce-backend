import { MODULE_METADATA } from '@nestjs/common/constants';
import type { CircuitBreakerFactory, OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_REPOSITORY, PRODUCT_SEARCH_STATE } from './application/ports';
import { CatalogModule } from './catalog.module';
import {
  CachingProductRepository,
  DrizzleProductRepository,
  SEARCH_ENGINE_BREAKER,
  SEARCH_ENGINE_CALL,
  isSearchEngineFault,
} from './infrastructure';

interface ProviderEntry {
  provide?: unknown;
  useClass?: unknown;
  useExisting?: unknown;
  useFactory?: (...deps: unknown[]) => unknown;
}

function providerFor(token: symbol): ProviderEntry | undefined {
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CatalogModule) ?? []) as ProviderEntry[];
  return providers.find((provider) => typeof provider === 'object' && provider.provide === token);
}

function boundTo(token: symbol): unknown {
  const entry = providerFor(token);
  return entry?.useExisting ?? entry?.useClass;
}

describe('CatalogModule', () => {
  // The indexer writes what it reads under the version it reads, so it must read the row, never a
  // cache generation whose invalidation has not landed.
  it('feeds the search state from the uncached repository', () => {
    expect(boundTo(PRODUCT_REPOSITORY)).toBe(CachingProductRepository);
    expect(boundTo(PRODUCT_SEARCH_STATE)).toBe(DrizzleProductRepository);
  });

  // Counting a 4xx would let one malformed query open the breaker and blank search for everyone.
  it('breaks search engine calls on engine faults only, within the request timeout', () => {
    const create = vi.fn((): OutboundCall => ({ run: (task) => task() }));
    const breakers: Pick<CircuitBreakerFactory, 'create'> = { create };

    providerFor(SEARCH_ENGINE_CALL)?.useFactory?.(fakeConfigService({ 'search.requestTimeoutMs': 1_234 }), breakers);

    expect(create).toHaveBeenCalledWith(SEARCH_ENGINE_BREAKER, {
      timeoutMs: 1_234,
      isDownstreamFault: isSearchEngineFault,
    });
  });
});
