import { hrtime } from 'node:process';

const NS_PER_MS = 1_000_000n;

/** @internal Clock seam. Production always uses `systemClock`; nothing but a test may supply another. */
export interface IdentityClock {
  /** Wall-clock milliseconds. May step in either direction when NTP adjusts it. */
  wallMs(): number;
  /** Non-decreasing milliseconds from an arbitrary origin. Stands still while the host is suspended. */
  monotonicMs(): number;
  /** Real elapsed nanoseconds, bounding how long a spin may block. */
  elapsedNs(): bigint;
}

/** @internal Deliberately left out of the package index. */
export const systemClock: IdentityClock = {
  wallMs: () => Date.now(),
  monotonicMs: () => Number(hrtime.bigint() / NS_PER_MS),
  elapsedNs: () => hrtime.bigint(),
};
