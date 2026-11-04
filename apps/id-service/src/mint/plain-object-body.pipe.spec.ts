import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PlainObjectBodyPipe } from './plain-object-body.pipe';

describe('PlainObjectBodyPipe', () => {
  const pipe = new PlainObjectBodyPipe();

  it('hands a plain object on unchanged', () => {
    const body = { count: 3 };

    expect(pipe.transform(body)).toBe(body);
  });

  it.each([
    ['null', null],
    ['an empty array', []],
    ['an array of objects', [{ count: 1 }]],
    ['a string', 'count'],
    ['a number', 3],
    ['a boolean', true],
  ])('refuses %s with 400', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(new BadRequestException('request body must be a JSON object'));
  });
});
