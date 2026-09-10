import { Money } from './money.vo';
import { DomainError } from './domain-error';

describe('Money', () => {
  it('adds two amounts of the same currency', () => {
    const sum = Money.of(1000, 'VND').add(Money.of(500, 'VND'));
    expect(sum.amountMinor).toBe(1500);
    expect(sum.currency).toBe('VND');
  });

  it('subtracts and can go negative', () => {
    const diff = Money.of(300, 'VND').subtract(Money.of(500, 'VND'));
    expect(diff.amountMinor).toBe(-200);
    expect(diff.isNegative()).toBe(true);
  });

  it('multiplies by an integer quantity', () => {
    expect(Money.of(1500, 'VND').multiply(3).amountMinor).toBe(4500);
  });

  it('rejects a non-integer factor in multiply', () => {
    expect(() => Money.of(1500, 'VND').multiply(1.5)).toThrow(DomainError);
  });

  it('throws when adding across currencies', () => {
    expect(() => Money.of(1000, 'VND').add(Money.of(1, 'USD'))).toThrow(DomainError);
  });

  it('throws when comparing across currencies', () => {
    expect(() => Money.of(1000, 'VND').compare(Money.of(1000, 'USD'))).toThrow(DomainError);
  });

  it('rejects a non-integer amount', () => {
    expect(() => Money.of(10.5, 'VND')).toThrow(DomainError);
  });

  it('rejects an empty or wrong-length currency', () => {
    expect(() => Money.of(100, '')).toThrow(DomainError);
    expect(() => Money.of(100, 'DONG')).toThrow(DomainError);
  });

  it('normalizes currency to upper-case', () => {
    expect(Money.of(100, 'vnd').currency).toBe('VND');
  });

  it('compares equal by value regardless of currency case', () => {
    expect(Money.of(100, 'vnd').equals(Money.of(100, 'VND'))).toBe(true);
    expect(Money.of(100, 'VND').equals(Money.of(200, 'VND'))).toBe(false);
  });

  it('reports zero', () => {
    expect(Money.zero('VND').isZero()).toBe(true);
    expect(Money.of(1, 'VND').isZero()).toBe(false);
  });

  it('orders amounts with compare', () => {
    expect(Money.of(100, 'VND').compare(Money.of(200, 'VND'))).toBe(-1);
    expect(Money.of(200, 'VND').compare(Money.of(100, 'VND'))).toBe(1);
    expect(Money.of(100, 'VND').compare(Money.of(100, 'VND'))).toBe(0);
  });
});
