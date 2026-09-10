import { describe, expect, it } from 'vitest';
import { UnsupportedContentTypeError, assertAllowedContentType, extensionFor } from './asset-content-type';

describe('asset content types', () => {
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/avif', 'avif'],
  ] as const)('maps %s to .%s', (contentType, extension) => {
    expect(extensionFor(assertAllowedContentType(contentType))).toBe(extension);
  });

  it('normalises case and surrounding whitespace before matching', () => {
    expect(assertAllowedContentType('  IMAGE/PNG ')).toBe('image/png');
  });

  it.each(['image/svg+xml', 'text/html', 'application/pdf', 'image/png; charset=utf-8', ''])(
    'refuses %s',
    (contentType) => {
      expect(() => assertAllowedContentType(contentType)).toThrow(UnsupportedContentTypeError);
    },
  );

  it('is not fooled by inherited Object properties', () => {
    expect(() => assertAllowedContentType('constructor')).toThrow(UnsupportedContentTypeError);
  });
});
