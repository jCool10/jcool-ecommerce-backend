import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AdjustStockUseCase } from './adjust-stock.use-case';
import type { StockAdminPort } from './ports/stock-admin.port';

const VARIANT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const LEVEL = { onHand: 40, reserved: 3, available: 37 };

function build(port: Partial<StockAdminPort> = {}) {
  const getLevel = vi.fn().mockResolvedValue(null);
  const setOnHand = vi.fn().mockResolvedValue(LEVEL);
  const adjust = vi.fn().mockResolvedValue(null);
  const stock: StockAdminPort = { getLevel, setOnHand, adjust, ...port };
  return { useCase: new AdjustStockUseCase(stock), getLevel, setOnHand, adjust };
}

describe('AdjustStockUseCase', () => {
  it('creates the row when setting an absolute level for a SKU that has none', async () => {
    const { useCase, setOnHand } = build();

    await expect(useCase.setOnHand(VARIANT, 40)).resolves.toEqual(LEVEL);
    expect(setOnHand).toHaveBeenCalledExactlyOnceWith(VARIANT, 40);
  });

  it('refuses to adjust a SKU whose stock was never initialised', async () => {
    const { useCase } = build({ adjust: vi.fn().mockResolvedValue(null) });

    await expect(useCase.adjust(VARIANT, 25)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the level the database computed, not one it assembled', async () => {
    const adjusted = { onHand: 65, reserved: 3, available: 62 };
    const { useCase } = build({ adjust: vi.fn().mockResolvedValue(adjusted) });

    await expect(useCase.adjust(VARIANT, 25)).resolves.toEqual(adjusted);
  });

  it('reports a SKU with no stock row as absent', async () => {
    const { useCase } = build();

    await expect(useCase.getLevel(VARIANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads back an existing level', async () => {
    const { useCase } = build({ getLevel: vi.fn().mockResolvedValue(LEVEL) });

    await expect(useCase.getLevel(VARIANT)).resolves.toEqual(LEVEL);
  });
});
