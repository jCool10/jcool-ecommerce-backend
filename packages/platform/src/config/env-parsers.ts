// parseInt that falls back on absent/empty/non-numeric input. Without the guard the empty-string→NaN
// env gotcha registers a 0ms interval or silently disables the window the value was there to bound.
export function parseIntOr(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
