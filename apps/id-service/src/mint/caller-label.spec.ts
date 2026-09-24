import { describe, expect, it } from 'vitest';
import { callerLabel } from './caller-label';

describe('callerLabel', () => {
  it('keeps a well-formed service name', () => {
    const names = ['api', 'user-service', 'a', `a${'b'.repeat(31)}`];

    expect(names.map(callerLabel)).toEqual(names);
  });

  it('buckets anything else as unknown', () => {
    const headers = [undefined, '', 'API', '1api', `a${'b'.repeat(32)}`, 'api; drop table', ['api', 'api']];

    expect(headers.map(callerLabel)).toEqual(headers.map(() => 'unknown'));
  });
});
