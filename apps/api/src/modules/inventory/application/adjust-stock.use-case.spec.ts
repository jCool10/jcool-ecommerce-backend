import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { AdjustStockUseCase } from './adjust-stock.use-case';
import type { StockAdminPort } from './ports/stock-admin.port';

const VARIANT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const LEVEL = { onHand: 40, reserved: 3, available: 37 };

function build(port: Partial<StockAdminPort> = {}) {
  const getLevel = vi.fn().mockResolvedValue(null);
  const setOnHand = vi.fn().mockResolvedValue(LEVEL);
  const adjust = vi.fn().mockResolvedValue(null);
  const stock: StockAdminPort = { getLevel, setOnHand, adjust, ...port };
  const info = vi.fn();
  const useCase = new AdjustStockUseCase(stock, fakePinoLogger({ info }));
  return { useCase, getLevel, setOnHand, adjust, info };
}

describe('AdjustStockUseCase', () => {
  it('creates the row when setting an absolute level for a SKU that has none, and logs the admin write', async () => {
    const { useCase, setOnHand, info } = build();

    await expect(useCase.setOnHand(VARIANT, 40)).resolves.toEqual(LEVEL);
    expect(setOnHand).toHaveBeenCalledExactlyOnceWith(VARIANT, 40);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      { variantId: VARIANT, quantityOnHand: 40 },
      'stock level set by admin',
    );
  });

  it('refuses to adjust a SKU whose stock was never initialised, and logs nothing', async () => {
    const { useCase, info } = build({ adjust: vi.fn().mockResolvedValue(null) });

    await expect(useCase.adjust(VARIANT, 25)).rejects.toBeInstanceOf(NotFoundException);
    expect(info).not.toHaveBeenCalled();
  });

  it('returns the level the database computed, not one it assembled, and logs the admin delta', async () => {
    const adjusted = { onHand: 65, reserved: 3, available: 62 };
    const { useCase, info } = build({ adjust: vi.fn().mockResolvedValue(adjusted) });

    await expect(useCase.adjust(VARIANT, 25)).resolves.toEqual(adjusted);
    expect(info).toHaveBeenCalledExactlyOnceWith({ variantId: VARIANT, delta: 25 }, 'stock adjusted by admin');
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
