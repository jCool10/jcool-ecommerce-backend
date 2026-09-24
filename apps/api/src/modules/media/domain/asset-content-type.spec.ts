import { describe, expect, it } from 'vitest';
import { UnsupportedContentTypeError, assertAllowedContentType, extensionFor } from './asset-content-type';

describe('asset content types', () => {
  it('normalises case and whitespace, and takes the extension from its own table', () => {
    const contentType = assertAllowedContentType('  IMAGE/WEBP ');

    expect(contentType).toBe('image/webp');
    expect(extensionFor(contentType)).toBe('webp');
  });

  it('refuses anything outside the raster allowlist', () => {
    // SVG is executable XML; a parameterised type is not the signed one; `constructor` is an
    // inherited Object key that a plain `in` lookup would accept.
    const refused = ['image/svg+xml', 'text/html', 'image/png; charset=utf-8', '', 'constructor', '__proto__'];

    for (const contentType of refused) {
      expect(() => assertAllowedContentType(contentType), contentType).toThrow(UnsupportedContentTypeError);
    }
  });
});
