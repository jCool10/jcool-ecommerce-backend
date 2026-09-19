import type { ArgumentsHost } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import type { Counter } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { LeaseNotHeldError } from '@jcool/id-generator';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { LeaseNotHeldFilter } from './lease-not-held.filter';

function httpHost() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { method: 'POST', path: '/v1/ids', route: { path: '/v1/ids' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('LeaseNotHeldFilter', () => {
  it('answers 503 LEASE_NOT_HELD with the request id, counting and logging the rejection', () => {
    const warn = vi.fn();
    const rejections = { inc: vi.fn() };
    const cls = { isActive: () => true, getId: () => 'req-1' } as unknown as ClsService;
    const filter = new LeaseNotHeldFilter(fakePinoLogger({ warn }), cls, rejections as unknown as Counter);
    const { host, response } = httpHost();

    filter.catch(new LeaseNotHeldError('fenced'), host);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 503,
      code: 'LEASE_NOT_HELD',
      message: 'Service unavailable',
      requestId: 'req-1',
    });
    expect(rejections.inc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'fenced', route: '/v1/ids' }),
      expect.any(String),
    );
  });
});
