import { NotFoundException } from '@nestjs/common';
import { ParseProductIdOrSlugPipe } from './parse-product-id-or-slug.pipe';

describe('ParseProductIdOrSlugPipe', () => {
  const pipe = new ParseProductIdOrSlugPipe();

  it.each(['137465797020397179', 'wireless-headphones', '123', 'a'.repeat(200)])('accepts %s', (value) => {
    expect(pipe.transform(value)).toBe(value);
  });

  it.each(['\0', 'a\0b', '', 'Has Space', 'UPPER', 'a--b', 'a'.repeat(201), undefined])(
    'answers 404 for %j',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(NotFoundException);
    },
  );
});
