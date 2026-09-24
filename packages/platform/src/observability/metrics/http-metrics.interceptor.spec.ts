import { Controller, Get, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Counter, Histogram, Registry } from 'prom-client';
import { lastValueFrom, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { HTTP_REQUESTS_TOTAL, HTTP_REQUEST_DURATION_SECONDS } from './metric-definitions';

@Controller('products')
class ProductsController {
  @Get(':idOrSlug')
  findOne(this: void): void {}
}

@Controller('metrics')
class MetricsController {
  @Get()
  index(this: void): void {}
}

async function request(
  controller: new () => object,
  handler: () => void,
  handle: () => Observable<unknown>,
  statusCode = 200,
): Promise<Registry> {
  const registry = new Registry();
  const labelNames = ['method', 'route', 'status_code'];
  const interceptor = new HttpMetricsInterceptor(
    new Histogram({ name: HTTP_REQUEST_DURATION_SECONDS, help: 'h', labelNames, registers: [registry] }),
    new Counter({ name: HTTP_REQUESTS_TOTAL, help: 'h', labelNames, registers: [registry] }),
    new Reflector(),
  );
  const context = new ExecutionContextHost(
    [{ method: 'GET', path: '/products/abc' }, { statusCode }],
    controller,
    handler,
  );
  await lastValueFrom(interceptor.intercept(context, { handle }), { defaultValue: undefined }).catch(() => undefined);
  return registry;
}

async function countedLabels(registry: Registry): Promise<unknown[]> {
  const { values } = await registry.getSingleMetric(HTTP_REQUESTS_TOTAL)!.get();
  return values.map((sample) => sample.labels);
}

describe('HttpMetricsInterceptor', () => {
  // On the error path the exception filter has not yet written the status to the response.
  it('labels the status from the response, or from the exception on error', async () => {
    const findOne = ProductsController.prototype.findOne;
    const outcomes = await Promise.all([
      request(ProductsController, findOne, () => of({ id: 'abc' }), 201),
      request(ProductsController, findOne, () => throwError(() => new NotFoundException())),
      request(ProductsController, findOne, () => throwError(() => new Error('pool exhausted'))),
    ]);

    const route = { method: 'GET', route: '/products/:idOrSlug' };
    expect(await Promise.all(outcomes.map(countedLabels))).toEqual([
      [{ ...route, status_code: 201 }],
      [{ ...route, status_code: 404 }],
      [{ ...route, status_code: 500 }],
    ]);
    expect(await outcomes[2].metrics()).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_count{method="GET",route="/products/:idOrSlug",status_code="500"} 1`,
    );
  });

  it('does not measure the scrape endpoint itself', async () => {
    const registry = await request(MetricsController, MetricsController.prototype.index, () => of('# metrics'));

    expect(await countedLabels(registry)).toEqual([]);
  });
});
