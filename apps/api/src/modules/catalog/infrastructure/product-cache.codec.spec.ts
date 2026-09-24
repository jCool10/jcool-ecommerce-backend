import { Money } from '@jcool/kernel';
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
    ['asset-1', 'asset-2'],
  );
}

describe('product cache codec', () => {
  it('round-trips a product through JSON with Money, Date and image ids intact', () => {
    const original = build();

    const wire = JSON.parse(JSON.stringify(toProductSnapshot(original))) as ProductSnapshot;
    const restored = fromProductSnapshot(wire);

    expect(restored).toBeInstanceOf(Product);
    expect(restored.createdAt.toISOString()).toBe(original.createdAt.toISOString());
    expect(restored.variants[0].prices[0]).toBeInstanceOf(Money);
    expect(restored.variants[0].prices[0].equals(Money.of(199_000, 'VND'))).toBe(true);
    expect({ ...restored }).toEqual({ ...original });
  });

  it('keeps a null description, which is a real value rather than drift', () => {
    const snapshot = { ...toProductSnapshot(build()), description: null };

    expect(fromProductSnapshot(snapshot).description).toBeNull();
  });

  it('throws on a snapshot whose price no longer satisfies the Money invariant', () => {
    const snapshot = toProductSnapshot(build());
    snapshot.variants[0].prices[0].amountMinor = 199.5;

    expect(() => fromProductSnapshot(snapshot)).toThrow();
  });

  // Each of these used to decode into a Product with undefined fields and 500 downstream.
  it('rejects a snapshot whose shape drifted', () => {
    const drifts: Record<string, (snapshot: ProductSnapshot) => unknown> = {
      'missing category': ({ category: _omitted, ...rest }) => rest,
      'missing name': ({ name: _omitted, ...rest }) => rest,
      'renamed status field': ({ status: _omitted, ...rest }) => ({ ...rest, state: 'ACTIVE' }),
      'status outside the vocabulary': (snapshot) => ({ ...snapshot, status: 'PUBLISHED' }),
      'numeric name': (snapshot) => ({ ...snapshot, name: 42 }),
      'undefined description': (snapshot) => ({ ...snapshot, description: undefined }),
      'category missing its slug': (snapshot) => ({ ...snapshot, category: { name: 'Audio' } }),
      'variants not an array': (snapshot) => ({ ...snapshot, variants: {} }),
      'variant missing its sku': (snapshot) => ({ ...snapshot, variants: [{ id: 'v-1', name: 'Black', prices: [] }] }),
      'price amount as a string': (snapshot) => ({
        ...snapshot,
        variants: [{ id: 'v-1', sku: 'WH-001', name: 'Black', prices: [{ amountMinor: '199000', currency: 'VND' }] }],
      }),
      'unparseable createdAt': (snapshot) => ({ ...snapshot, createdAt: 'not-a-date' }),
      // The shape a pre-image deploy wrote.
      'missing imageAssetIds': ({ imageAssetIds: _omitted, ...rest }) => rest,
    };

    for (const [drift, corrupt] of Object.entries(drifts)) {
      expect(() => fromProductSnapshot(corrupt(toProductSnapshot(build()))), drift).toThrow(TypeError);
    }
  });
});
