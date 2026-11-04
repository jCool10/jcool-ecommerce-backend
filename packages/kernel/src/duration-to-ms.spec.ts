import { durationToMs } from './duration-to-ms';

describe('durationToMs', () => {
  it('parses a number with a case-insensitive unit', () => {
    const expected: Record<string, number> = {
      '15m': 900_000,
      '7d': 604_800_000,
      '3600s': 3_600_000,
      '500ms': 500,
      '1h': 3_600_000,
      ' 15m ': 900_000,
      '15M': 900_000,
    };

    const parsed = Object.fromEntries(Object.keys(expected).map((input) => [input, durationToMs(input)]));

    expect(parsed).toEqual(expected);
  });

  it('throws on anything else', () => {
    for (const input of ['', 'abc', '15x', 'm', '1.5h', '-5m', '900', '300']) {
      expect(() => durationToMs(input), input).toThrow(/Invalid duration/);
    }
  });

  // Past 2^53 the result is no longer the exact count of milliseconds asked for.
  it('refuses a duration whose milliseconds are past the safe-integer range', () => {
    expect(durationToMs(`${Number.MAX_SAFE_INTEGER}ms`)).toBe(Number.MAX_SAFE_INTEGER);
    for (const input of ['9007199254740993ms', '999999999999d']) {
      expect(() => durationToMs(input), input).toThrow(/Invalid duration/);
    }
  });
});
