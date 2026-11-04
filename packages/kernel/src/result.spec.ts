import { DomainError } from './domain-error';
import { err, ok } from './result';

describe('Result', () => {
  it('wraps a value as the ok arm', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });

  it('wraps an error as the failed arm', () => {
    const error = new DomainError('Cart is empty');

    expect(err(error)).toEqual({ ok: false, error });
  });
});
