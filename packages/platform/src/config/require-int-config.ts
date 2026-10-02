import type { ConfigService } from '@nestjs/config';

// A mistyped key reads as undefined, and `setInterval(fn, undefined)` fires every event-loop turn,
// so a scheduler refuses to build rather than boot that busy loop.
export function requireIntConfig(config: ConfigService, key: string, min: number): number {
  const value = config.get<number>(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`Invalid config: ${key} must be an integer >= ${min}`);
  }
  return value;
}
