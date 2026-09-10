const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function durationToMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${value}"`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ? match[2].toLowerCase() : 'ms';
  return amount * UNIT_TO_MS[unit];
}
