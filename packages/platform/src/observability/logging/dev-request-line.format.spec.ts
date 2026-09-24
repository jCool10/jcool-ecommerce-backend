import { describe, expect, it } from 'vitest';
import { formatDevRequestLine } from './dev-request-line.format';

// ESC is built at runtime to keep a control character out of the source and the regex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('formatDevRequestLine', () => {
  it('renders the morgan dev shape: method route status time - size db', () => {
    const line = formatDevRequestLine({
      method: 'GET',
      route: '/products/:idOrSlug',
      statusCode: 200,
      durationMs: 12.345,
      contentLength: 431,
      dbQueries: 3,
    });
    expect(plain(line)).toBe('GET /products/:idOrSlug 200 12.345 ms - 431 db=3');
  });

  it('renders "-" for a missing duration or content-length, and drops db when absent', () => {
    const line = formatDevRequestLine({
      method: 'POST',
      route: '/orders',
      statusCode: 201,
      durationMs: undefined,
      contentLength: undefined,
    });
    expect(plain(line)).toBe('POST /orders 201 - - -');
  });
});
