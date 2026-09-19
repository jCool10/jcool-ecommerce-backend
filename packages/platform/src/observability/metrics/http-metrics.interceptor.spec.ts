import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Counter, Histogram } from 'prom-client';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

function httpContext(controller: object, handler: () => void, statusCode: number): ExecutionContext {
  const request = { method: 'GET', path: '/concrete' };
  const response = { statusCode };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => controller,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

function reflectorFor(controller: object, controllerPath: string, handlerPath: string): Reflector {
  return {
    get: (_key: unknown, target: unknown): string => (target === controller ? controllerPath : handlerPath),
  } as unknown as Reflector;
}

function build(reflector: Reflector) {
  const observe = vi.fn<(labels: Record<string, unknown>, value: number) => void>();
  const inc = vi.fn<(labels: Record<string, unknown>) => void>();
  const interceptor = new HttpMetricsInterceptor(
    { observe } as unknown as Histogram<string>,
    { inc } as unknown as Counter<string>,
    reflector,
  );
  return { interceptor, observe, inc };
}

describe('HttpMetricsInterceptor', () => {
  it('records duration + count with method, route template and status on success', async () => {
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const { interceptor, observe, inc } = build(reflectorFor(controller, 'products', ':idOrSlug'));

    const next = { handle: () => of({ id: 'abc' }) } as unknown as CallHandler;
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
    });

    const labels = { method: 'GET', route: '/products/:idOrSlug', status_code: 200 };
    expect(inc).toHaveBeenCalledWith(labels);
    expect(observe).toHaveBeenCalledTimes(1);
    const [observedLabels, seconds] = observe.mock.calls[0];
    expect(observedLabels).toEqual(labels);
    expect(typeof seconds).toBe('number');
  });

  it('derives the status from the exception on the error path (filter has not set it yet)', async () => {
    const controller = class ProductsController {};
    const handler = function findOne(): void {};
    const { interceptor, inc } = build(reflectorFor(controller, 'products', ':idOrSlug'));

    const next = { handle: () => throwError(() => new NotFoundException()) } as unknown as CallHandler;
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ error: () => resolve() });
    });

    expect(inc).toHaveBeenCalledWith({ method: 'GET', route: '/products/:idOrSlug', status_code: 404 });
  });

  it('does not measure the scrape endpoint itself', async () => {
    const controller = class MetricsController {};
    const handler = function index(): void {};
    const { interceptor, observe, inc } = build(reflectorFor(controller, 'metrics', ''));

    const next = { handle: () => of('# metrics') } as unknown as CallHandler;
    await new Promise<void>((resolve) => {
      interceptor.intercept(httpContext(controller, handler, 200), next).subscribe({ complete: () => resolve() });
    });

    expect(observe).not.toHaveBeenCalled();
    expect(inc).not.toHaveBeenCalled();
  });

  it('skips non-http contexts', () => {
    const { interceptor, observe, inc } = build(reflectorFor({}, '', ''));
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    const next = { handle: () => of('x') } as unknown as CallHandler;

    interceptor.intercept(context, next).subscribe();
    expect(observe).not.toHaveBeenCalled();
    expect(inc).not.toHaveBeenCalled();
  });
});
