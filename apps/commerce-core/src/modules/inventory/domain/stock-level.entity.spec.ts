import { describe, expect, it } from 'vitest';
import { StockLevel } from './stock-level.entity';
import { InsufficientStockError } from './errors/insufficient-stock.error';

// Pins the in-memory model only. The never-oversell invariant lives in StockRepository's SQL plus
// the `ck_stock_no_oversell` CHECK and is covered e2e — nothing here exercises it.
const stock = (onHand: number, reserved = 0, version = 0): StockLevel =>
  StockLevel.rehydrate({ variantId: 'sku-a', quantityOnHand: onHand, quantityReserved: reserved, version });

describe('StockLevel entity', () => {
  it('availableQuantity() = onHand − reserved', () => {
    expect(stock(10, 3).availableQuantity()).toBe(7);
  });

  it('rehydrate() keeps the stored counters and version verbatim', () => {
    const s = stock(10, 3, 5);
    expect(s.quantityOnHand).toBe(10);
    expect(s.quantityReserved).toBe(3);
    expect(s.version).toBe(5);
  });

  it('canReserve() is true up to the derived available quantity', () => {
    expect(stock(10, 3).canReserve(7)).toBe(true);
  });

  it('canReserve() is false beyond the derived available quantity', () => {
    expect(stock(10, 3).canReserve(8)).toBe(false);
  });

  it('canReserve() rejects a non-positive or fractional quantity', () => {
    const s = stock(10, 3);
    expect(s.canReserve(0)).toBe(false);
    expect(s.canReserve(-1)).toBe(false);
    expect(s.canReserve(1.5)).toBe(false);
  });

  it('reserve() raises reserved and bumps version in memory when it fits', () => {
    const s = stock(10, 3, 5);
    s.reserve(2);
    expect(s.quantityReserved).toBe(5);
    expect(s.availableQuantity()).toBe(5);
    expect(s.version).toBe(6);
    expect(s.quantityOnHand).toBe(10); // on-hand is untouched by a hold
  });

  it('reserve() beyond available throws InsufficientStockError and leaves in-memory state unchanged', () => {
    const s = stock(10, 3, 5);
    expect(() => s.reserve(8)).toThrow(InsufficientStockError);
    expect(s.quantityReserved).toBe(3);
    expect(s.version).toBe(5);
  });
});
