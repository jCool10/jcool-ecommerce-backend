import { Money } from '@shared/kernel';
import { describe, expect, it } from 'vitest';
import { Product } from '../domain/entities';
import { fromProductSnapshot, toProductSnapshot, type ProductSnapshot } from './product-cache.codec';

function build(): Product {
  return new Product(
    'p-1',
    'Wireless Headphones',
    'wireless-headphones',
    'Over-ear',
    'ACTIVE',
    { slug: 'audio', name: 'Audio' },
    [
      {
        id: 'v-1',
        sku: 'WH-001',
        name: 'Black',
        prices: [Money.of(199_000, 'VND'), Money.of(1_299, 'USD')],
      },
      { id: 'v-2', sku: 'WH-002', name: 'White', prices: [] },
    ],
    new Date('2026-08-12T09:41:00.000Z'),
  );
}

describe('product cache codec', () => {
  it('round-trips a product through JSON with Money and Date intact', () => {
    const original = build();

    const wire = JSON.parse(JSON.stringify(toProductSnapshot(original))) as ProductSnapshot;
    const restored = fromProductSnapshot(wire);

    expect(restored).toBeInstanceOf(Product);
    expect(restored.createdAt.toISOString()).toBe(original.createdAt.toISOString());
    expect(restored.variants[0].prices[0]).toBeInstanceOf(Money);
    expect(restored.variants[0].prices[0].equals(Money.of(199_000, 'VND'))).toBe(true);
    expect(restored.variants[0].prices[1].currency).toBe('USD');
    expect(restored.variants[1].prices).toEqual([]);
    expect({ ...restored }).toEqual({ ...original });
  });

  it('throws on a snapshot whose price no longer satisfies the Money invariant', () => {
    const snapshot = toProductSnapshot(build());
    snapshot.variants[0].prices[0].amountMinor = 199.5;

    expect(() => fromProductSnapshot(snapshot)).toThrow();
  });

  it('throws on an unparseable createdAt rather than yielding an Invalid Date', () => {
    const snapshot = { ...toProductSnapshot(build()), createdAt: 'not-a-date' };

    expect(() => fromProductSnapshot(snapshot)).toThrow(TypeError);
  });

  // Every one of these used to decode into a Product with undefined fields and 500 downstream.
  describe('rejects a snapshot whose shape drifted', () => {
    const cases: { name: string; corrupt: (snapshot: ProductSnapshot) => unknown }[] = [
      { name: 'missing category', corrupt: ({ category: _omitted, ...rest }) => rest },
      { name: 'missing name', corrupt: ({ name: _omitted, ...rest }) => rest },
      { name: 'renamed status field', corrupt: ({ status: _omitted, ...rest }) => ({ ...rest, state: 'ACTIVE' }) },
      { name: 'status outside the vocabulary', corrupt: (snapshot) => ({ ...snapshot, status: 'PUBLISHED' }) },
      { name: 'numeric name', corrupt: (snapshot) => ({ ...snapshot, name: 42 }) },
      { name: 'undefined description', corrupt: (snapshot) => ({ ...snapshot, description: undefined }) },
      { name: 'category missing its slug', corrupt: (snapshot) => ({ ...snapshot, category: { name: 'Audio' } }) },
      { name: 'variants not an array', corrupt: (snapshot) => ({ ...snapshot, variants: {} }) },
      {
        name: 'variant missing its sku',
        corrupt: (snapshot) => ({ ...snapshot, variants: [{ id: 'v-1', name: 'Black', prices: [] }] }),
      },
      {
        name: 'price amount as a string',
        corrupt: (snapshot) => ({
          ...snapshot,
          variants: [{ id: 'v-1', sku: 'WH-001', name: 'Black', prices: [{ amountMinor: '199000', currency: 'VND' }] }],
        }),
      },
    ];

    it.each(cases)('$name', ({ corrupt }) => {
      const drifted = corrupt(toProductSnapshot(build())) as ProductSnapshot;

      expect(() => fromProductSnapshot(drifted)).toThrow(TypeError);
    });
  });

  it('keeps a null description, which is a real value rather than drift', () => {
    const snapshot = { ...toProductSnapshot(build()), description: null };

    expect(fromProductSnapshot(snapshot).description).toBeNull();
  });
});
