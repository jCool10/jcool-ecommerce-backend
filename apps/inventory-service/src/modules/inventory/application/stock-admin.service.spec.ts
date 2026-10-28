import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { StockAdminService } from './stock-admin.service';
import type { StockView } from './ports/stock-admin.port';

const LEVEL: StockView = { onHand: 40, reserved: 5, available: 35 };

function build(found = true) {
  const level = found ? LEVEL : null;
  const getLevel = vi.fn(() => Promise.resolve(level));
  const setOnHand = vi.fn(() => Promise.resolve(LEVEL));
  const adjust = vi.fn(() => Promise.resolve(level));
  const info = vi.fn();
  const service = new StockAdminService({ getLevel, setOnHand, adjust }, fakePinoLogger({ info }));
  return { service, getLevel, setOnHand, adjust, info };
}

describe('StockAdminService', () => {
  it('reads a stock level and 404s a variant with no stock row', async () => {
    const { service, getLevel } = build();

    await expect(service.getLevel('variant-1')).resolves.toEqual(LEVEL);
    expect(getLevel).toHaveBeenCalledWith('variant-1');
    await expect(build(false).service.getLevel('variant-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sets on-hand as an audited admin write', async () => {
    const { service, setOnHand, info } = build();

    await expect(service.setOnHand('variant-1', 40)).resolves.toEqual(LEVEL);

    expect(setOnHand).toHaveBeenCalledWith('variant-1', 40);
    expect(info).toHaveBeenCalledWith({ variantId: 'variant-1', quantityOnHand: 40 }, 'stock level set by admin');
  });

  it('adjusts by a delta as an audited admin write', async () => {
    const { service, adjust, info } = build();

    await expect(service.adjust('variant-1', -3)).resolves.toEqual(LEVEL);

    expect(adjust).toHaveBeenCalledWith('variant-1', -3);
    expect(info).toHaveBeenCalledWith({ variantId: 'variant-1', delta: -3 }, 'stock adjusted by admin');
  });

  it('404s an adjustment against a variant with no stock row, without an audit line', async () => {
    const { service, info } = build(false);

    await expect(service.adjust('variant-1', 5)).rejects.toBeInstanceOf(NotFoundException);
    expect(info).not.toHaveBeenCalled();
  });
});
