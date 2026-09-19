// Bounds the map for a caller that keys on something more varied than intended. Clearing beats
// tracking an eviction order for a map that should never approach this size.
const MAX_KEYS = 256;

/**
 * At most one line per key per window. The conditions worth sampling arrive in bursts (a rate
 * limiter shedding a flood), and a line per event turns a defence into an amplifier at the moment
 * the process can least afford it. The metric already carries the count; the log only names it.
 */
export function createLogSampler(windowMs: number): (key: string) => boolean {
  const lastLoggedAt = new Map<string, number>();

  return (key: string): boolean => {
    const now = Date.now();
    const previous = lastLoggedAt.get(key);
    if (previous !== undefined && now - previous < windowMs) {
      return false;
    }
    if (lastLoggedAt.size >= MAX_KEYS) {
      lastLoggedAt.clear();
    }
    lastLoggedAt.set(key, now);
    return true;
  };
}
