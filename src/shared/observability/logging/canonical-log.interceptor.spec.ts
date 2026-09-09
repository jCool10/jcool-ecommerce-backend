import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalLogInterceptor } from './canonical-log.interceptor';

// Express sets content-length while serializing the body, i.e. after the interceptor chain unwinds
// — so the stub exposes the header only once the response has actually been written.
function httpContext(
  controller: object,
  handler: () => void,
  statusCode: number,
): { context: ExecutionContext; finishResponse: () => void; abortResponse: () => void } {
  const request = { method: 'GET', path: '/concrete' };
  const listeners = new Map<string, Array<() => void>>();
  let bodySent = false;
  // Faithful to `once`: a listener is dropped as it fires, so a later event cannot re-run it.
  const emit = (event: string): void => {
    const fired = listeners.get(event) ?? [];
    listeners.delete(event);
    for (const listener of fired) listener();
  };
  const response = {
    statusCode,
    getHeader: (name: string): string | undefined => (bodySent && name === 'content-length' ? '431' : undefined),
    once: (event: string, listener: () => void): void => {
      const existing = listeners.get(event);
      if (existing) existing.push(listener);
      else listeners.set(event, [listener]);
    },
  };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => controller,
    getHandler: () => handler,
  } as unknown as ExecutionContext;

  return {
    context,
    // Node emits 'close' after 'finish' on a response that completed normally, so the stub does too.
    finishResponse: (): void => {
      bodySent = true;
      emit('finish');
      emit('close');
    },
    // A connection dropped mid-flight: 'close' alone, and content-length was never set.
    abortResponse: (): void => emit('close'),
  };
}

function configFor(env: string): ConfigService {
  return { get: () => env } as unknown as ConfigService;
}

// The start stamp must be a real bigint, or getRequestDurationMs yields undefined.
function clsStub(): ClsService {
  return {
    isActive: () => true,
    get: (key: unknown): unknown => (key === 'requestStart' ? process.hrtime.bigint() - 1_000_000n : 3),
  } as unknown as ClsService;
}

function reflectorFor(controller: object, controllerPath: string, handlerPath: string): Reflector {
  return {
    get: (_key: unknown, target: unknown): string => (target === controller ? controllerPath : handlerPath),
  } as unknown as Reflector;
}

describe('CanonicalLogInterceptor', () => {
  it('logs one "request completed" line with method, route template, status, durationMs, db.queries', async () => {
    const info = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const logger = { info } as unknown as PinoLogger;
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const interceptor = new CanonicalLogInterceptor(
      logger,
      clsStub(),
      reflectorFor(controller, 'products', ':idOrSlug'),
      configFor('production'),
    );

    const next = { handle: () => of({ id: 'abc' }) } as unknown as CallHandler;
    const { context } = httpContext(controller, handler, 200);
    await new Promise<void>((resolve) => {
      interceptor.intercept(context, next).subscribe({ complete: () => resolve() });
    });

    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0];
    expect(message).toBe('request completed');
    expect(fields).toMatchObject({
      method: 'GET',
      route: '/products/:idOrSlug',
      statusCode: 200,
      'db.queries': 3,
    });
    expect(typeof fields.durationMs).toBe('number');
  });

  it('logs a morgan dev-style one-line string (not a structured object) in development', async () => {
    const info = vi.fn<(objOrMsg: unknown, msg?: string) => void>();
    const logger = { info } as unknown as PinoLogger;
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const interceptor = new CanonicalLogInterceptor(
      logger,
      clsStub(),
      reflectorFor(controller, 'products', ':idOrSlug'),
      configFor('development'),
    );

    const next = { handle: () => of({ id: 'abc' }) } as unknown as CallHandler;
    const { context, finishResponse } = httpContext(controller, handler, 200);
    await new Promise<void>((resolve) => {
      interceptor.intercept(context, next).subscribe({ complete: () => resolve() });
    });

    // The size field is only knowable once the body has been written.
    expect(info).not.toHaveBeenCalled();
    finishResponse();

    expect(info).toHaveBeenCalledTimes(1);
    const [line, second] = info.mock.calls[0];
    expect(typeof line).toBe('string');
    expect(second).toBeUndefined();
    // Status and db are wrapped in ANSI color, so only substrings contiguous around those codes
    // can be asserted.
    const text = line as string;
    expect(text).toContain('GET /products/:idOrSlug ');
    expect(text).toContain('200');
    expect(text).toContain(' ms - 431');
    expect(text).toContain('db=3');
  });

  it('still logs the dev line when the connection is aborted before the body is written', async () => {
    const info = vi.fn<(objOrMsg: unknown, msg?: string) => void>();
    const logger = { info } as unknown as PinoLogger;
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const interceptor = new CanonicalLogInterceptor(
      logger,
      clsStub(),
      reflectorFor(controller, 'products', ':idOrSlug'),
      configFor('development'),
    );

    const next = { handle: () => of({ id: 'abc' }) } as unknown as CallHandler;
    const { context, abortResponse } = httpContext(controller, handler, 200);
    await new Promise<void>((resolve) => {
      interceptor.intercept(context, next).subscribe({ complete: () => resolve() });
    });

    abortResponse();

    expect(info).toHaveBeenCalledTimes(1);
    const text = info.mock.calls[0][0] as string;
    expect(text).toContain('GET /products/:idOrSlug ');
    // Size renders as `-`: the body never reached the socket, so there is no content-length.
    expect(text).toContain(' ms - -');
  });

  it('does not log for health-probe routes (noise from orchestrator liveness/readiness)', async () => {
    const info = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const logger = { info } as unknown as PinoLogger;
    const controller = class HealthController {};
    const handler = function live(): void {};
    const interceptor = new CanonicalLogInterceptor(
      logger,
      clsStub(),
      reflectorFor(controller, 'health', 'live'),
      configFor('production'),
    );

    const next = { handle: () => of({ status: 'ok' }) } as unknown as CallHandler;
    const { context } = httpContext(controller, handler, 200);
    await new Promise<void>((resolve) => {
      interceptor.intercept(context, next).subscribe({ complete: () => resolve() });
    });

    expect(info).not.toHaveBeenCalled();
  });

  it('does not log for non-http contexts (e.g. scheduled/rpc)', () => {
    const info = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const logger = { info } as unknown as PinoLogger;
    const reflector = { get: () => '' } as unknown as Reflector;

    const interceptor = new CanonicalLogInterceptor(logger, clsStub(), reflector, configFor('production'));
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    const next = { handle: () => of('x') } as unknown as CallHandler;

    interceptor.intercept(context, next).subscribe();
    expect(info).not.toHaveBeenCalled();
  });
});
