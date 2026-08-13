import { sha256Hex } from './sha256-hex';

/** SHA-256 (hex) of an opaque refresh token; delegates to {@link sha256Hex} so every digest stays identical. */
export function hashRefreshToken(rawToken: string): string {
  return sha256Hex(rawToken);
}
