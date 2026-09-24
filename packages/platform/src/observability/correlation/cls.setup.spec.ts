import type { ClsService } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { correlationHeaders } from './cls.setup';

function fakeCls(opts: { active: boolean; id?: string }): ClsService {
  return { isActive: () => opts.active, getId: () => opts.id } as unknown as ClsService;
}

describe('correlationHeaders', () => {
  it('passes the request id downstream, and nothing outside a request', () => {
    expect(correlationHeaders(fakeCls({ active: true, id: 'req-uuid' }))).toEqual({ 'x-request-id': 'req-uuid' });
    expect(correlationHeaders(fakeCls({ active: false }))).toEqual({});
  });
});
