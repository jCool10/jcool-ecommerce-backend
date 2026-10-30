import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { SweepRejectedOrdersUseCase } from './sweep-rejected-orders.use-case';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY_MS = 86_400_000;

function build(days: number | undefined) {
  const deleteRejectedBefore = vi.fn().mockResolvedValue(3);
  const registry = new RetentionSweepRegistry();
  const make = () =>
    new SweepRejectedOrdersUseCase(
      { deleteRejectedBefore } as unknown as OrderRepositoryPort,
      fakeConfigService({ 'retention.rejectedOrderDays': days }),
      registry,
    );
  return { make, deleteRejectedBefore, registry };
}

describe('SweepRejectedOrdersUseCase', () => {
  useFakeClock(NOW);

  it('deletes rejected orders settled longer ago than the retention, one batch at a time', async () => {
    const { make, deleteRejectedBefore } = build(30);

    expect(await make().sweep(500)).toBe(3);
    expect(deleteRejectedBefore).toHaveBeenCalledExactlyOnceWith(new Date(NOW.getTime() - 30 * DAY_MS), 500);
  });

  it('registers under its own name', () => {
    const { make, registry } = build(30);
    const register = vi.spyOn(registry, 'register');
    const sweep = make();

    sweep.onModuleInit();

    expect(sweep.name).toBe('order:rejected-orders');
    expect(register).toHaveBeenCalledWith(sweep);
  });

  it('refuses to boot without a retention', () => {
    expect(() => build(undefined).make()).toThrow(/retention.rejectedOrderDays/);
  });
});
