import { MODULE_METADATA } from '@nestjs/common/constants';
import type { CircuitBreakerFactory, OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_REPOSITORY, PRODUCT_SEARCH_STATE } from './application/ports';
import { CatalogModule } from './catalog.module';
import {
  CachingProductRepository,
  DrizzleProductRepository,
  SEARCH_ENGINE_CALLS,
  SEARCH_READ_BREAKER,
  SEARCH_WRITE_BREAKER,
  isSearchEngineFault,
  type SearchEngineCalls,
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

  // Counting a 4xx would let one malformed query open a breaker, and sharing one would let shed index
  // writes blank search for everyone.
  it('breaks search reads and index writes apart, on engine faults only, within the request timeout', () => {
    const create = vi.fn((): OutboundCall => ({ run: (task) => task() }));
    const breakers: Pick<CircuitBreakerFactory, 'create'> = { create };

    const calls = providerFor(SEARCH_ENGINE_CALLS)?.useFactory?.(
      fakeConfigService({ 'search.requestTimeoutMs': 1_234 }),
      breakers,
    ) as SearchEngineCalls;

    const options = { timeoutMs: 1_234, isDownstreamFault: isSearchEngineFault };
    expect(create.mock.calls).toEqual([
      [SEARCH_READ_BREAKER, options],
      [SEARCH_WRITE_BREAKER, options],
    ]);
    expect(SEARCH_READ_BREAKER).not.toBe(SEARCH_WRITE_BREAKER);
    expect(calls.read).toBe(create.mock.results[0]?.value);
    expect(calls.write).toBe(create.mock.results[1]?.value);
  });
});
