import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ClsService } from 'nestjs-cls';
import { firstValueFrom, of, throwError } from 'rxjs';
import { type Mock, describe, expect, it, vi } from 'vitest';
import { computeRequestHash } from '@shared/idempotency';
import type { IdempotencyRecord, IdempotencyStorePort } from '../application/ports/idempotency-store.port';
import { IdempotencyInterceptor } from './idempotency.interceptor';

const USER = { userId: 'u1', role: 'CUSTOMER', jti: 'j', exp: 1 };
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SCOPE = 'user:u1';
const HASH = computeRequestHash('POST', '/orders', SCOPE, {});

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

function record(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    id: 'rec1',
    scope: SCOPE,
    key: KEY,
    requestHash: HASH,
    status: 'IN_PROGRESS',
    responseStatus: null,
    responseBody: null,
    orderId: null,
    method: 'POST',
    path: '/orders',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

function build(store: StoreMock) {
  const set = vi.fn();
  const cls = { set, isActive: () => true, get: vi.fn() } as unknown as ClsService;
  const interceptor = new IdempotencyInterceptor(store as unknown as IdempotencyStorePort, cls);
  return { interceptor, set };
}

function context(status?: Mock): ExecutionContext {
  const request = { method: 'POST', path: '/orders', headers: {}, body: {}, user: USER, idempotencyKey: KEY };
  const response = { status: status ?? vi.fn() } as unknown as Response;
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

function handlerOf(returnValue: unknown): { handler: CallHandler; handle: Mock } {
  const handle = vi.fn(() => of(returnValue));
  return { handler: { handle }, handle };
}

function throwingHandler(error: unknown): CallHandler {
  return { handle: vi.fn(() => throwError(() => error)) };
}

describe('IdempotencyInterceptor', () => {
  it('runs the handler on a fresh key and hands the CLS context to the checkout tx (never completes the row itself)', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(record());
    const { interceptor, set } = build(store);
    const body = { id: 'o1', status: 'PENDING' };

    const obs = await interceptor.intercept(context(), handlerOf(body).handler);
    const result = await firstValueFrom(obs);

    expect(result).toEqual(body);
    expect(set).toHaveBeenCalledWith('idempotency', { scope: SCOPE, key: KEY });
    // COMPLETED is written inside the handler's checkout transaction, not here.
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

  it('replays a COMPLETED record without invoking the handler', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(null);
    const cached = { id: 'o1' };
    store.findByScopeAndKey.mockResolvedValue(
      record({ status: 'COMPLETED', responseStatus: 201, responseBody: cached }),
    );
    const { interceptor } = build(store);
    const statusSpy = vi.fn();
    const { handler, handle } = handlerOf({ should: 'not run' });

    const obs = await interceptor.intercept(context(statusSpy), handler);
    const result = await firstValueFrom(obs);

    expect(result).toEqual(cached);
    expect(statusSpy).toHaveBeenCalledWith(201);
    expect(handle).not.toHaveBeenCalled();
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

  it('rejects a same-key request with a different body as 422', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(null);
    store.findByScopeAndKey.mockResolvedValue(record({ requestHash: 'a-different-hash' }));
    const { interceptor } = build(store);

    await expect(interceptor.intercept(context(), handlerOf({}).handler)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('returns 409 while a matching request is still in progress', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(null);
    store.findByScopeAndKey.mockResolvedValue(
      record({ status: 'IN_PROGRESS', expiresAt: new Date(Date.now() + 60_000) }),
    );
    const { interceptor } = build(store);

    await expect(interceptor.intercept(context(), handlerOf({}).handler)).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns 409 when the row vanished between the failed insert and the read', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(null);
    store.findByScopeAndKey.mockResolvedValue(null);
    const { interceptor } = build(store);

    await expect(interceptor.intercept(context(), handlerOf({}).handler)).rejects.toBeInstanceOf(ConflictException);
  });

  it('reclaims an expired IN_PROGRESS row and re-runs the handler', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValueOnce(null).mockResolvedValueOnce(record());
    store.findByScopeAndKey.mockResolvedValue(
      record({ status: 'IN_PROGRESS', expiresAt: new Date(Date.now() - 1_000) }),
    );
    const { interceptor } = build(store);

    const obs = await interceptor.intercept(context(), handlerOf({ id: 'o2' }).handler);
    const result = await firstValueFrom(obs);

    expect(result).toEqual({ id: 'o2' });
    expect(store.deleteExpiredInProgress).toHaveBeenCalledWith(SCOPE, KEY, expect.any(Date));
    expect(store.tryInsertInProgress).toHaveBeenCalledTimes(2);
    // The reclaimed handler re-runs; its checkout tx (not the interceptor) marks the row COMPLETED.
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

  it('drops the IN_PROGRESS row and propagates an unexpected 5xx (never caches it)', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(record());
    const { interceptor } = build(store);
    const boom = new Error('boom');

    const obs = await interceptor.intercept(context(), throwingHandler(boom));

    await expect(firstValueFrom(obs)).rejects.toBe(boom);
    expect(store.deleteInProgress).toHaveBeenCalledWith(SCOPE, KEY);
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

  it('drops the IN_PROGRESS row on a deterministic business 4xx so a retry re-runs', async () => {
    const store = makeStore();
    store.tryInsertInProgress.mockResolvedValue(record());
    const { interceptor } = build(store);
    const rejection = new BadRequestException('Cart is empty');

    const obs = await interceptor.intercept(context(), throwingHandler(rejection));

    await expect(firstValueFrom(obs)).rejects.toBe(rejection);
    expect(store.deleteInProgress).toHaveBeenCalledWith(SCOPE, KEY);
    expect(store.markCompleted).not.toHaveBeenCalled();
  });
});
