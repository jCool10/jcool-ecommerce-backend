import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { SweepRejectedOrdersUseCase } from './sweep-rejected-orders.use-case';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const DAY_MS = 86_400_000;

function build() {
  const orders = { deleteRejectedBefore: vi.fn().mockResolvedValue(3) };
  const registry = new RetentionSweepRegistry();
  const useCase = new SweepRejectedOrdersUseCase(
    orders as unknown as OrderRepositoryPort,
    fakeConfigService({ 'retention.rejectedOrderDays': 30 }),
    registry,
  );
  return { useCase, orders, registry };
}

describe('SweepRejectedOrdersUseCase', () => {
  useFakeClock(NOW);

  it('deletes a batch of rejected orders finalized before the retention window', async () => {
    const { useCase, orders } = build();

    await expect(useCase.sweep(500)).resolves.toBe(3);

    expect(orders.deleteRejectedBefore).toHaveBeenCalledExactlyOnceWith(new Date(NOW.getTime() - 30 * DAY_MS), 500);
  });

  it('joins the shared retention registry on init', () => {
    const { useCase, registry } = build();
    const register = vi.spyOn(registry, 'register');

    useCase.onModuleInit();

    expect(register).toHaveBeenCalledExactlyOnceWith(useCase);
    expect(useCase.name).toBe('order:rejected-orders');
  });
});
