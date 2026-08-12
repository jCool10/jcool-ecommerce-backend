import { durationToMs } from './duration-to-ms';

describe('durationToMs', () => {
  it.each([
    ['15m', 900_000],
    ['7d', 604_800_000],
    ['3600s', 3_600_000],
    ['500ms', 500],
    ['1h', 3_600_000],
    ['900', 900], // bare number = milliseconds
    [' 15m ', 900_000], // trims surrounding whitespace
    ['15M', 900_000], // unit is case-insensitive
  ])('parses %s -> %d ms', (input: string, expected: number) => {
    expect(durationToMs(input)).toBe(expected);
  });

  it.each(['', 'abc', '15x', 'm', '1.5h', '-5m'])('throws on invalid duration %p', (input: string) => {
    expect(() => durationToMs(input)).toThrow(/Invalid duration/);
  });
});
