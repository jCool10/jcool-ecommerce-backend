import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { resolveRouteTemplate } from './http-route.util';

// Reflector fake: returns the controller path for the class target, the handler path for the
// method target — mirroring how @Controller()/@Get() metadata is read.
function reflectorFor(controller: object, controllerPath: string, handlerPath: string): Reflector {
  return {
    get: (_key: unknown, target: unknown): string => (target === controller ? controllerPath : handlerPath),
  } as unknown as Reflector;
}

function contextFor(controller: object, handler: () => void): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('resolveRouteTemplate', () => {
  const controller = class ProductsController {};
  const handler = function findOne(): void {};

  it('joins controller + handler paths into a template, keeping the param placeholder', () => {
    const route = resolveRouteTemplate(
      reflectorFor(controller, 'products', ':idOrSlug'),
      contextFor(controller, handler),
      '/products/abc-123',
    );
    expect(route).toBe('/products/:idOrSlug');
  });

  it('collapses an empty handler path (index route) without a trailing slash', () => {
    const route = resolveRouteTemplate(
      reflectorFor(controller, 'products', ''),
      contextFor(controller, handler),
      '/products',
    );
    expect(route).toBe('/products');
  });

  it('falls back to the concrete path when no template metadata exists', () => {
    const route = resolveRouteTemplate(
      reflectorFor(controller, '', ''),
      contextFor(controller, handler),
      '/some/raw/path',
    );
    expect(route).toBe('/some/raw/path');
  });
});
