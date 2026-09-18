import { Slug } from './slug.vo';
import { DomainError } from '@shared/kernel';

describe('Slug', () => {
  it('accepts a valid kebab slug', () => {
    expect(Slug.of('wireless-headphones').value).toBe('wireless-headphones');
  });

  it('trims and lowercases', () => {
    expect(Slug.of('  Wireless-Headphones  ').value).toBe('wireless-headphones');
  });

  it('rejects empty', () => {
    expect(() => Slug.of('')).toThrow(DomainError);
    expect(() => Slug.of('   ')).toThrow(DomainError);
  });

  it('rejects spaces and illegal characters', () => {
    expect(() => Slug.of('wireless headphones')).toThrow(DomainError);
    expect(() => Slug.of('slug_with_underscore')).toThrow(DomainError);
  });

  it('rejects leading, trailing, or doubled hyphens', () => {
    expect(() => Slug.of('-lead')).toThrow(DomainError);
    expect(() => Slug.of('trail-')).toThrow(DomainError);
    expect(() => Slug.of('double--hyphen')).toThrow(DomainError);
  });

  it('compares equal by value', () => {
    expect(Slug.of('abc').equals(Slug.of('ABC'))).toBe(true);
  });
});
