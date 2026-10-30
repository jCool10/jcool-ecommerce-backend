import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isRoutableId } from '@jcool/id-codec';
import { type CartLineBody, MAX_SKU_VIEW_BATCH, type SkuViewBody, apiReadRoutes } from '@jcool/internal-contracts';
import { CURRENCY, type CatalogSkuSeed } from '@jcool/internal-contracts/testing';
import { testId } from './id-service-stub';

export type ApiStubRoute = 'cartLines' | 'skuViews';

export interface StubSku extends SkuViewBody {
  productId: string;
}

export interface ApiStubRequest {
  route: ApiStubRoute;
  url: string;
  body: unknown;
}

/** `Infinity` keeps the fault on until `clearFault` or `reset`. */
export interface FaultOptions {
  times?: number;
}

type Fault = { remaining: number } & ({ kind: 'status'; status: number } | { kind: 'hang'; arrived: () => void });

/**
 * Stands in for the api's cart and catalog reads. Follows the shared case table in
 * `@jcool/internal-contracts`; `api-internal-stub-contract` keeps the two from drifting. One per
 * worker process, wiped with the database before every test.
 */
export class ApiInternalStub {
  private readonly skus = new Map<string, StubSku>();
  private readonly carts = new Map<string, CartLineBody[]>();
  private readonly faults = new Map<ApiStubRoute, Fault>();
  private readonly log: ApiStubRequest[] = [];
  private readonly hanging = new Set<ServerResponse>();
  private readonly server: Server = createServer((req, res) => this.handle(req, res));

  static async start(): Promise<ApiInternalStub> {
    const stub = new ApiInternalStub();
    await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
    stub.server.unref();
    return stub;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** A product with one variant, the SKU; priced and active unless told otherwise. */
  seedSku(sku: Partial<StubSku> = {}): StubSku {
    const skuId = sku.skuId ?? testId();
    const seeded: StubSku = {
      skuId,
      productId: sku.productId ?? testId(),
      productName: sku.productName ?? `Product ${skuId}`,
      unitPriceMinor: sku.unitPriceMinor === undefined ? 150_000 : sku.unitPriceMinor,
      currency: sku.currency ?? CURRENCY,
      isActive: sku.isActive ?? true,
    };
    this.skus.set(skuId, seeded);
    return { ...seeded };
  }

  seedCatalogSku({ priceMinor, productStatus = 'ACTIVE', variantArchived = false }: CatalogSkuSeed): StubSku {
    return this.seedSku({ unitPriceMinor: priceMinor, isActive: productStatus === 'ACTIVE' && !variantArchived });
  }

  updateSku(skuId: string, patch: Partial<Omit<StubSku, 'skuId'>>): void {
    const sku = this.skus.get(skuId);
    if (!sku) throw new Error(`api stub has no SKU ${skuId}`);
    this.skus.set(skuId, { ...sku, ...patch });
  }

  /** The price stays: the api reads an archived product inactive, not unpriced. */
  archiveProduct(productId: string): void {
    for (const sku of this.skus.values()) {
      if (sku.productId === productId) this.skus.set(sku.skuId, { ...sku, isActive: false });
    }
  }

  removeSku(skuId: string): void {
    this.skus.delete(skuId);
  }

  /** A SKU already in the cart keeps its place and gains the quantity, as in the api's cart. */
  addLine(userId: string, skuId: string, quantity: number): void {
    const lines = this.carts.get(userId) ?? [];
    const line = lines.find((existing) => existing.skuId === skuId);
    if (line) line.quantity += quantity;
    else lines.push({ skuId, quantity });
    this.carts.set(userId, lines);
  }

  cartOf(userId: string): CartLineBody[] {
    return (this.carts.get(userId) ?? []).map((line) => ({ ...line }));
  }

  /** Answers the next `times` calls to the route with a bare `status`. */
  fail(route: ApiStubRoute, status: number, { times = 1 }: FaultOptions = {}): void {
    this.faults.set(route, { kind: 'status', status, remaining: times });
  }

  /** Never answers the next `times` calls, so only the caller's deadline ends them. */
  hang(route: ApiStubRoute, { times = 1 }: FaultOptions = {}): { reached: Promise<void> } {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    this.faults.set(route, { kind: 'hang', arrived, remaining: times });
    return { reached };
  }

  clearFault(route: ApiStubRoute): void {
    this.faults.delete(route);
  }

  /** Every request that reached the route, faulted ones included. */
  requests(route: ApiStubRoute): ApiStubRequest[] {
    return this.log.filter((request) => request.route === route);
  }

  calls(route: ApiStubRoute): number {
    return this.requests(route).length;
  }

  reset(): void {
    this.skus.clear();
    this.carts.clear();
    this.faults.clear();
    this.log.length = 0;
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => this.answer(req, res, raw));
  }

  private answer(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const route = routeOf(req.method, req.url ?? '');
    if (!route) return void reply(res, 404, { statusCode: 404, message: 'Not Found' });
    const body = parse(raw);
    this.log.push({ route: route.name, url: req.url ?? '', body });

    const fault = this.faults.get(route.name);
    if (fault) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.faults.delete(route.name);
      if (fault.kind === 'status') return void reply(res, fault.status, { statusCode: fault.status });
      fault.arrived();
      this.hanging.add(res);
      res.on('close', () => this.hanging.delete(res));
      return;
    }

    // The real controller's order: caller token guard, then the id pipe or the body.
    if (req.headers.authorization !== `Bearer ${requiredEnv('API_SERVICE_TOKEN')}`) {
      return void reply(res, 401, { statusCode: 401, message: 'Unauthorized' });
    }
    if (route.name === 'cartLines') {
      if (!isRoutableId(route.userId)) return void badRequest(res);
      return void reply(res, 200, { lines: this.cartOf(route.userId) });
    }

    const skuIds = isRecord(body) ? body.skuIds : undefined;
    if (!isSkuBatch(skuIds)) return void badRequest(res);
    // Catalog order, not request order, as the real read answers.
    const asked = new Set(skuIds);
    const views = [...this.skus.values()]
      .filter((sku) => asked.has(sku.skuId))
      .map(({ productId: _productId, ...view }) => view);
    reply(res, 200, { views });
  }
}

const CART_LINES = /^\/internal\/v1\/carts\/([^/]+)\/lines$/;

function routeOf(
  method: string | undefined,
  path: string,
): { name: 'cartLines'; userId: string } | { name: 'skuViews' } | null {
  const cart = method === 'GET' ? CART_LINES.exec(path) : null;
  if (cart) return { name: 'cartLines', userId: decodeURIComponent(cart[1]) };
  if (method === 'POST' && path === apiReadRoutes.skuViews) return { name: 'skuViews' };
  return null;
}

function isSkuBatch(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_SKU_VIEW_BATCH &&
    value.every((id) => typeof id === 'string' && isRoutableId(id))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(raw: string): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function badRequest(res: ServerResponse): void {
  reply(res, 400, { statusCode: 400, message: 'Bad Request' });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set for the e2e run`);
  return value;
}

let started: Promise<ApiInternalStub> | undefined;

export function apiInternalStub(): Promise<ApiInternalStub> {
  started ??= ApiInternalStub.start();
  return started;
}
