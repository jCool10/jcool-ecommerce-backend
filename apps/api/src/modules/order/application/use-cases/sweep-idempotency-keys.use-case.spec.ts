import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import type { IdempotencyStorePort } from '../ports/idempotency-store.port';
import { SweepIdempotencyKeysUseCase } from './sweep-idempotency-keys.use-case';

const NOW = new Date('2026-09-07T12:00:00.000Z');

describe('SweepIdempotencyKeysUseCase', () => {
  useFakeClock(NOW);

  // A grace added to now would collect unexpired keys, turning a retried POST /orders into a second order.
  it('moves the cutoff into the past, never into the future', async () => {
    const store = { deleteExpired: vi.fn().mockResolvedValue(0) };
    const config = fakeConfigService({ 'retention.idempotencyGraceSec': 3600 });
    const useCase = new SweepIdempotencyKeysUseCase(
      store as unknown as IdempotencyStorePort,
      config,
      new RetentionSweepRegistry(),
    );

    await useCase.sweep(500);

    expect(store.deleteExpired).toHaveBeenCalledWith(new Date(NOW.getTime() - 3_600_000), 500);
  });
});
