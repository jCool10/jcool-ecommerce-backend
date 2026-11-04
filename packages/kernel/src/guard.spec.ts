import { DomainError } from './domain-error';
import { assertInteger, assertMaxLen, assertNonEmpty, assertPositive } from './guard';

describe('assertNonEmpty', () => {
  it.each([null, undefined, '', '   '])('refuses %j', (value) => {
    expect(() => assertNonEmpty(value, 'Name')).toThrow(new DomainError('Name must not be empty'));
  });

  it('accepts text with content', () => {
    expect(() => assertNonEmpty(' a ', 'Name')).not.toThrow();
  });
});

describe('assertPositive', () => {
  // `value <= 0` would let NaN through, since every comparison with NaN is false.
  it.each([0, -1, NaN])('refuses %d', (value) => {
    expect(() => assertPositive(value, 'Quantity')).toThrow(new DomainError('Quantity must be positive'));
  });

  it('accepts 1', () => {
    expect(() => assertPositive(1, 'Quantity')).not.toThrow();
  });
});

describe('assertMaxLen', () => {
  it('accepts exactly the limit and refuses one past it', () => {
    expect(() => assertMaxLen('abcde', 5, 'Code')).not.toThrow();
    expect(() => assertMaxLen('abcdef', 5, 'Code')).toThrow(new DomainError('Code must be at most 5 characters'));
  });
});

describe('assertInteger', () => {
  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])('refuses %d', (value) => {
    expect(() => assertInteger(value, 'Amount')).toThrow(new DomainError('Amount must be a safe integer'));
  });

  it('accepts the largest safe integer', () => {
    expect(() => assertInteger(Number.MAX_SAFE_INTEGER, 'Amount')).not.toThrow();
  });
});
