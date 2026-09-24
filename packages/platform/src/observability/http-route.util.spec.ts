import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it } from 'vitest';
import { resolveRouteTemplate } from './http-route.util';

@Controller('products')
class ProductsController {
  @Get(':idOrSlug')
  findOne(this: void): void {}

  @Get()
  list(this: void): void {}
}

class UnroutedController {
  handle(this: void): void {}
}

describe('resolveRouteTemplate', () => {
  it('joins controller and handler paths, falling back to the concrete path', () => {
    const route = (controller: new () => object, handler: () => void, path: string): string =>
      resolveRouteTemplate(new Reflector(), new ExecutionContextHost([], controller, handler), path);

    expect([
      route(ProductsController, ProductsController.prototype.findOne, '/products/abc-123'),
      route(ProductsController, ProductsController.prototype.list, '/products'),
      route(UnroutedController, UnroutedController.prototype.handle, '/some/raw/path'),
    ]).toEqual(['/products/:idOrSlug', '/products', '/some/raw/path']);
  });
});
