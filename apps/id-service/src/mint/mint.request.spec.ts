import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { MAX_IDS_PER_REQUEST, MintRequest } from './mint.request';

const parse = (body: object) => {
  const request = plainToInstance(MintRequest, body);
  return { request, errors: validateSync(request).map((error) => error.property) };
};

describe('MintRequest', () => {
  it('defaults count to a single id', () => {
    const { request, errors } = parse({});
    expect(request.count).toBe(1);
    expect(errors).toEqual([]);
  });

  it('accepts the edges of the count range', () => {
    expect(parse({ count: 1 }).errors).toEqual([]);
    expect(parse({ count: MAX_IDS_PER_REQUEST }).errors).toEqual([]);
  });

  it.each([
    [{ count: MAX_IDS_PER_REQUEST + 1 }, 'count'],
    [{ count: 0 }, 'count'],
  ])('refuses %o', (body, property) => {
    expect(parse(body).errors).toEqual([property]);
  });
});
