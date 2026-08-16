import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { ReserveStockUseCase } from './reserve-stock.use-case';

// Pure dispatch: config strategy → which port method runs.
const TX = {} as unknown as DrizzleTx;
const LINES = [{ variantId: 'sku-a', quantity: 1 }];

function setup(strategy: string | undefined) {
  const stock = {
    reservePessimistic: vi.fn().mockResolvedValue(undefined),
    reserveOptimistic: vi.fn().mockResolvedValue(undefined),
    getStockView: vi.fn().mockResolvedValue(null),
  };
  const config = { get: vi.fn().mockReturnValue(strategy) };
  const uc = new ReserveStockUseCase(stock, config as unknown as ConfigService);
  return { uc, stock };
}

describe('ReserveStockUseCase strategy dispatch', () => {
  it('defaults to pessimistic when the strategy is unset', async () => {
    const { uc, stock } = setup(undefined);
    await uc.reserve(TX, 'order-1', LINES);
    expect(stock.reservePessimistic).toHaveBeenCalledWith(TX, 'order-1', LINES);
    expect(stock.reserveOptimistic).not.toHaveBeenCalled();
  });

  it('uses the optimistic adapter when configured optimistic', async () => {
    const { uc, stock } = setup('optimistic');
    await uc.reserve(TX, 'order-1', LINES);
    expect(stock.reserveOptimistic).toHaveBeenCalledWith(TX, 'order-1', LINES);
    expect(stock.reservePessimistic).not.toHaveBeenCalled();
  });

  it('uses the pessimistic adapter when configured pessimistic', async () => {
    const { uc, stock } = setup('pessimistic');
    await uc.reserve(TX, 'order-1', LINES);
    expect(stock.reservePessimistic).toHaveBeenCalledWith(TX, 'order-1', LINES);
    expect(stock.reserveOptimistic).not.toHaveBeenCalled();
  });
});
