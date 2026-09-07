import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalLogInterceptor } from './canonical-log.interceptor';

// A minimal ExecutionContext whose class/handler identities drive the reflector fake,
// matching the `as unknown as` mocking style used across the repo's guard specs.
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

// ConfigService fake: `app.env` drives the dev (morgan) vs prod (JSON) branch, and the slow
// threshold is high enough by default that a normal request never trips it.
function configFor(env: string, slowRequestMs = 1000): ConfigService {
  const values: Record<string, unknown> = { 'app.env': env, 'log.slowRequestMs': slowRequestMs };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

// CLS stub: a real bigint start (so getRequestDurationMs yields a number) and a fixed query tally.
// `elapsedMs` back-dates the start stamp, which is how a slow request is simulated.
function clsStub(elapsedMs = 1): ClsService {
  return {
    isActive: () => true,
    get: (key: unknown): unknown =>
      key === 'requestStart' ? process.hrtime.bigint() - BigInt(Math.round(elapsedMs * 1e6)) : 3,
  } as unknown as ClsService;
}

// Reflector returning the controller path for the class and the handler path for the method.
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
    // Single string arg (message only) — no structured fields object in dev.
    expect(typeof line).toBe('string');
    expect(second).toBeUndefined();
    // Morgan shape: `GET /products/:idOrSlug <200> 12.345 ms - 431 db=3`. Status and db are wrapped
    // in ANSI color, so assert only substrings that stay contiguous around those codes.
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

  // A slow success is invisible at `info` — it reads exactly like a fast one. Raising the level
  // puts latency under the `level:warn` alert rule teams already have.
  it('raises the line to warn with slow:true past the threshold', async () => {
    const info = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const warn = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const logger = { info, warn } as unknown as PinoLogger;
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const interceptor = new CanonicalLogInterceptor(
      logger,
      clsStub(50),
      reflectorFor(controller, 'products', ':idOrSlug'),
      configFor('production', 10),
    );

    const next = { handle: () => of({ id: 'abc' }) } as unknown as CallHandler;
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0];
    // Same message and shape as the fast line — only the level and the one extra field differ, so
    // a dashboard counting "request completed" still counts every request.
    expect(message).toBe('request completed');
    expect(fields).toMatchObject({ route: '/products/:idOrSlug', statusCode: 200, slow: true });
  });

  // A boolean `false` on every line is bytes carrying no news; absence is the signal.
  it('omits the slow field entirely under the threshold', async () => {
    const info = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const warn = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const logger = { info, warn } as unknown as PinoLogger;
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const interceptor = new CanonicalLogInterceptor(
      logger,
      clsStub(1),
      reflectorFor(controller, 'products', ':idOrSlug'),
      configFor('production', 1000),
    );

    const next = { handle: () => of({ id: 'abc' }) } as unknown as CallHandler;
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
    });

    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls[0][0]).not.toHaveProperty('slow');
  });

  // No start stamp means no duration to compare — an unknown duration is not a slow one.
  it('does not mark a request slow when the duration is unknown', async () => {
    const info = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const warn = vi.fn<(obj: Record<string, unknown>, msg?: string) => void>();
    const logger = { info, warn } as unknown as PinoLogger;
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const cls = { isActive: () => true, get: () => undefined } as unknown as ClsService;
    const interceptor = new CanonicalLogInterceptor(
      logger,
      cls,
      reflectorFor(controller, 'products', ':idOrSlug'),
      configFor('production', 1),
    );

    const next = { handle: () => of({ id: 'abc' }) } as unknown as CallHandler;
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
    });

    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls[0][0]).not.toHaveProperty('slow');
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
