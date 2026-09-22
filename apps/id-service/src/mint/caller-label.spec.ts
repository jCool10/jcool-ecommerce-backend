import { describe, expect, it } from 'vitest';
import { callerLabel } from './caller-label';

describe('callerLabel', () => {
  it.each(['api', 'user-service', 'a', `a${'b'.repeat(31)}`])('keeps a well-formed service name: %s', (caller) => {
    expect(callerLabel(caller)).toBe(caller);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['uppercase', 'API'],
    ['leading digit', '1api'],
    ['too long', `a${'b'.repeat(32)}`],
    ['free text', 'api; drop table'],
    ['repeated header', ['api', 'api']],
  ])('buckets anything else as unknown: %s', (_, caller) => {
    expect(callerLabel(caller)).toBe('unknown');
  });
});
