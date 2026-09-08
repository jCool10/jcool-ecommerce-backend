import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalLogInterceptor } from './canonical-log.interceptor';

function httpContext(controller: object, handler: () => void, statusCode: number): ExecutionContext {
  const request = { method: 'GET', path: '/concrete' };
  const response = { statusCode, getHeader: () => '431' };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => controller,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
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
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
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
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
    });

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
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
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
