import { durationToMs } from './duration-to-ms';

describe('durationToMs', () => {
  it('parses a number with an optional, case-insensitive unit', () => {
    const expected: Record<string, number> = {
      '15m': 900_000,
      '7d': 604_800_000,
      '3600s': 3_600_000,
      '500ms': 500,
      '1h': 3_600_000,
      ' 15m ': 900_000,
      '15M': 900_000,
      // No unit means milliseconds.
      '900': 900,
    };

    const parsed = Object.fromEntries(Object.keys(expected).map((input) => [input, durationToMs(input)]));

    expect(parsed).toEqual(expected);
  });

  it('throws on anything else', () => {
    for (const input of ['', 'abc', '15x', 'm', '1.5h', '-5m']) {
      expect(() => durationToMs(input), input).toThrow(/Invalid duration/);
    }
  });
});
