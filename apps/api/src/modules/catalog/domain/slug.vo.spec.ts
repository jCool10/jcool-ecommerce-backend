import { Slug } from './slug.vo';
import { DomainError } from '@jcool/kernel';

describe('Slug', () => {
  it('trims and lowercases a kebab slug', () => {
    expect(Slug.of('  Wireless-Headphones  ').value).toBe('wireless-headphones');
  });

  it('refuses anything that is not lowercase alphanumeric with single hyphens', () => {
    const refused = ['', '   ', 'wireless headphones', 'slug_with_underscore', '-lead', 'trail-', 'double--hyphen'];

    for (const raw of refused) {
      expect(() => Slug.of(raw), JSON.stringify(raw)).toThrow(DomainError);
    }
  });
});
