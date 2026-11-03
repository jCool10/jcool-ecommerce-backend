const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// The unit is mandatory: a bare `300` meant as seconds would silently become 300 ms.
export function durationToMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${value}" (expected a number with a unit: ms, s, m, h or d)`);
  }
  return Number(match[1]) * UNIT_TO_MS[match[2].toLowerCase()];
}
