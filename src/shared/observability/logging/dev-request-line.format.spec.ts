import { describe, expect, it } from 'vitest';
import { formatDevRequestLine } from './dev-request-line.format';

// Strip ANSI so assertions read the visible text; ESC () built at runtime to avoid a
// control character in the source / regex.
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

  it('colors status by class (2xx green … 5xx red) like morgan', () => {
    const green = `${String.fromCharCode(27)}[32m`;
    const red = `${String.fromCharCode(27)}[31m`;
    const base = { method: 'GET', route: '/x', durationMs: 1, contentLength: 0 };
    expect(formatDevRequestLine({ ...base, statusCode: 200 })).toContain(green);
    expect(formatDevRequestLine({ ...base, statusCode: 503 })).toContain(red);
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
