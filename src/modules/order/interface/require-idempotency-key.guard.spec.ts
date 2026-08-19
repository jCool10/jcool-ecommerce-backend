import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RequireIdempotencyKeyGuard, type IdempotentRequest } from './require-idempotency-key.guard';

const VALID_UUID = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function contextFor(headers: Record<string, string | string[]>): { ctx: ExecutionContext; request: IdempotentRequest } {
  const request = { headers } as unknown as IdempotentRequest;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('RequireIdempotencyKeyGuard', () => {
  const guard = new RequireIdempotencyKeyGuard();

  it('allows a valid UUID and normalizes it onto the request', () => {
    const { ctx, request } = contextFor({ 'idempotency-key': VALID_UUID });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(request.idempotencyKey).toBe(VALID_UUID);
  });

  it('uses the first value when the header is sent more than once', () => {
    const { ctx, request } = contextFor({ 'idempotency-key': [VALID_UUID, 'ignored'] });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(request.idempotencyKey).toBe(VALID_UUID);
  });

  it('rejects a missing header with 400', () => {
    const { ctx } = contextFor({});
    expect(() => guard.canActivate(ctx)).toThrow(BadRequestException);
  });

  it('rejects a non-UUID header with 400', () => {
    const { ctx } = contextFor({ 'idempotency-key': 'not-a-uuid' });
    expect(() => guard.canActivate(ctx)).toThrow(BadRequestException);
  });
});
