import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { MintRequest } from './mint.request';

const parse = (body: object) => {
  const request = plainToInstance(MintRequest, body);
  return { request, errors: validateSync(request).map((error) => error.property) };
};

describe('MintRequest', () => {
  it('defaults count to a single id', () => {
    const { request, errors } = parse({ bucket: 0 });
    expect(request.count).toBe(1);
    expect(errors).toEqual([]);
  });

  it('accepts the edges of both ranges', () => {
    expect(parse({ bucket: 4095, count: 1000 }).errors).toEqual([]);
  });

  it.each([
    [{ bucket: 4096 }, 'bucket'],
    [{ bucket: -1 }, 'bucket'],
    [{ bucket: 0, count: 1001 }, 'count'],
    [{ bucket: 0, count: 0 }, 'count'],
  ])('refuses %o', (body, property) => {
    expect(parse(body).errors).toEqual([property]);
  });
});
