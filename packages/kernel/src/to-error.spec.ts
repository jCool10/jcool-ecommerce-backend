import { toError } from './to-error';

describe('toError', () => {
  it('passes an Error through untouched', () => {
    const error = new TypeError('boom');

    expect(toError(error)).toBe(error);
  });

  it('wraps anything else in an Error carrying its string form', () => {
    const wrapped = [toError('boom'), toError(42), toError(undefined), toError({ code: 'E1' })];

    expect(wrapped.every((error) => error instanceof Error)).toBe(true);
    expect(wrapped.map((error) => error.message)).toEqual(['boom', '42', 'undefined', '[object Object]']);
  });
});
