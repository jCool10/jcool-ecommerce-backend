import { CallHandler, ConflictException, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import type { ClsService } from 'nestjs-cls';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { computeRequestHash } from '@shared/idempotency';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { IdempotencyRecord, IdempotencyStorePort } from '../application/ports/idempotency-store.port';
import { IdempotencyInterceptor } from './idempotency.interceptor';

const USER = { userId: 'u1', role: 'CUSTOMER', jti: 'j', exp: 1 };
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SCOPE = 'user:u1';

type StoreMock = { [K in keyof IdempotencyStorePort]: ReturnType<typeof vi.fn> };

function makeStore(): StoreMock {
  return {
    tryInsertInProgress: vi.fn(),
    findByScopeAndKey: vi.fn(),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    deleteInProgress: vi.fn().mockResolvedValue(undefined),
    deleteExpiredInProgress: vi.fn().mockResolvedValue(1),
    deleteExpired: vi.fn().mockResolvedValue(0),
  };
}

function record(): IdempotencyRecord {
  return {
    id: 'rec1',
    scope: SCOPE,
    key: KEY,
    requestHash: computeRequestHash('POST', '/orders', SCOPE, {}),
    status: 'IN_PROGRESS',
    responseStatus: null,
    responseBody: null,
    orderId: null,
    method: 'POST',
    path: '/orders',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  };
}

function build(store: StoreMock) {
  const cls = { set: vi.fn(), isActive: () => true, get: vi.fn() } as unknown as ClsService;
  const warn = vi.fn();
  const interceptor = new IdempotencyInterceptor(
    store as unknown as IdempotencyStorePort,
    cls,
    fakePinoLogger({ warn }),
  );
  return { interceptor, warn };
}

function context(): ExecutionContext {
  const request = { method: 'POST', path: '/orders', headers: {}, body: {}, user: USER, idempotencyKey: KEY };
  const response = { status: vi.fn() } as unknown as Response;
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

describe('IdempotencyInterceptor', () => {
  it('returns 409 when the row vanished between the failed insert and the read', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(null);
    store.findByScopeAndKey.mockResolvedValue(null);
    const { interceptor } = build(store);
    const handler: CallHandler = { handle: vi.fn(() => of({})) };

    await expect(interceptor.intercept(context(), handler)).rejects.toBeInstanceOf(ConflictException);
  });

  it('still propagates the original error when the IN_PROGRESS cleanup itself fails', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(record());
    store.deleteInProgress.mockRejectedValue(new Error('connection reset'));
    const { interceptor, warn } = build(store);
    const boom = new Error('boom');

    const obs = await interceptor.intercept(context(), { handle: vi.fn(() => throwError(() => boom)) });

    await expect(firstValueFrom(obs)).rejects.toBe(boom);
    // The key stays claimed until it expires, so the operator needs this line to know why retries 409.
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scope: SCOPE, key: KEY }),
      expect.any(String),
    );
  });
});
