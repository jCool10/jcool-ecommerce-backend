import { describe, expect, it } from 'vitest';
import { StockLevel } from './stock-level.entity';
import { InsufficientStockError } from './errors/insufficient-stock.error';

const stock = (onHand: number, reserved = 0, version = 0): StockLevel =>
  StockLevel.rehydrate({ variantId: 'sku-a', quantityOnHand: onHand, quantityReserved: reserved, version });

describe('StockLevel entity', () => {
  it('availableQuantity() = onHand − reserved', () => {
    expect(stock(10, 3).availableQuantity()).toBe(7);
  });

  it('canReserve() is true up to available', () => {
    expect(stock(10, 3).canReserve(7)).toBe(true);
  });

  it('canReserve() is false beyond available', () => {
    expect(stock(10, 3).canReserve(8)).toBe(false);
  });

  it('canReserve() rejects a non-positive or fractional quantity', () => {
    const s = stock(10, 3);
    expect(s.canReserve(0)).toBe(false);
    expect(s.canReserve(-1)).toBe(false);
    expect(s.canReserve(1.5)).toBe(false);
  });

  it('reserve() raises reserved and bumps version when it fits', () => {
    const s = stock(10, 3, 5);
    s.reserve(2);
    expect(s.quantityReserved).toBe(5);
    expect(s.availableQuantity()).toBe(5);
    expect(s.version).toBe(6);
    expect(s.quantityOnHand).toBe(10); // on-hand is untouched by a hold
  });

  it('reserve() to exactly available drives available to 0 (never oversells)', () => {
    const s = stock(1, 0);
    s.reserve(1);
    expect(s.availableQuantity()).toBe(0);
    expect(s.quantityReserved).toBe(1);
  });

  it('reserve() beyond available throws InsufficientStockError and leaves state unchanged', () => {
    const s = stock(10, 3, 5);
    expect(() => s.reserve(8)).toThrow(InsufficientStockError);
    expect(s.quantityReserved).toBe(3);
    expect(s.version).toBe(5);
  });
});
