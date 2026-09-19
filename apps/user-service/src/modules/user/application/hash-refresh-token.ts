import { sha256Hex } from './sha256-hex';

export function hashRefreshToken(rawToken: string): string {
  return sha256Hex(rawToken);
}
