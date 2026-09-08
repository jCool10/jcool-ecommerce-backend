import { DomainError } from '@shared/kernel';

/**
 * What may be stored, and the extension each one gets.
 *
 * An allowlist rather than a denylist, and raster formats only. `image/svg+xml` is excluded on
 * purpose: SVG is executable XML, and served from an origin it can run script. Nothing here sniffs
 * bytes, so there would be no second line of defence. Every `text/*` is out for the same reason.
 */
export const ALLOWED_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
} as const;

export type AllowedContentType = keyof typeof ALLOWED_CONTENT_TYPES;

export class UnsupportedContentTypeError extends DomainError {
  constructor(readonly contentType: string) {
    super(`Unsupported content type "${contentType}": allowed are ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}`);
    this.name = 'UnsupportedContentTypeError';
  }
}

export function isAllowedContentType(value: string): value is AllowedContentType {
  return Object.hasOwn(ALLOWED_CONTENT_TYPES, value);
}

export function assertAllowedContentType(value: string): AllowedContentType {
  const normalized = value.trim().toLowerCase();
  if (!isAllowedContentType(normalized)) throw new UnsupportedContentTypeError(value);
  return normalized;
}

/**
 * The extension comes from this table, never from the name the client sent. A client filename is
 * user data; putting it in a storage key invites path traversal and a mismatched type into a place
 * that needs neither.
 */
export function extensionFor(contentType: AllowedContentType): string {
  return ALLOWED_CONTENT_TYPES[contentType];
}
