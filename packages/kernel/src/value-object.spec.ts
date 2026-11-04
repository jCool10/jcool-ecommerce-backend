import { ValueObject } from './value-object';

class Sku extends ValueObject<{ code: string; size?: string }> {
  static of(code: string, size?: string): Sku {
    return new Sku(size === undefined ? { code } : { code, size });
  }
}

class Barcode extends ValueObject<{ code: string }> {
  static of(code: string): Barcode {
    return new Barcode({ code });
  }
}

describe('ValueObject.equals', () => {
  it('is true for the same props', () => {
    expect(Sku.of('A-1', 'M').equals(Sku.of('A-1', 'M'))).toBe(true);
  });

  it('is false for different props', () => {
    expect(Sku.of('A-1', 'M').equals(Sku.of('A-1', 'L'))).toBe(false);
  });

  it('is false for undefined and null', () => {
    expect(Sku.of('A-1').equals(undefined)).toBe(false);
    expect(Sku.of('A-1').equals(null as unknown as Sku)).toBe(false);
  });

  it('is false for another subclass holding the same props', () => {
    expect(Sku.of('A-1').equals(Barcode.of('A-1'))).toBe(false);
  });

  // Every key of the shorter set matches, so only the count tells them apart.
  it('is false when one side has an extra key', () => {
    expect(Sku.of('A-1').equals(Sku.of('A-1', 'M'))).toBe(false);
  });
});
