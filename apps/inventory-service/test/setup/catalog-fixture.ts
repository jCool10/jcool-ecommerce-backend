import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const VARIANTS_PER_PRODUCT = 2;

/** The public catalog's `GET /products` as the stock seed walks it, paged the way it asks. */
export class CatalogFixture {
  private variantIds: string[] = [];
  private failingPage: number | undefined;
  private readonly server: Server = createServer((req, res) => this.handle(req, res));

  static async start(): Promise<CatalogFixture> {
    const fixture = new CatalogFixture();
    await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
    return fixture;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Replaces what the catalog lists and clears any fault. */
  list(variantIds: string[]): void {
    this.variantIds = variantIds;
    this.failingPage = undefined;
  }

  failOnPage(page: number): void {
    this.failingPage = page;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.url);
    if (req.method !== 'GET' || url.pathname !== '/products') return void reply(res, 404, {});

    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    if (page === this.failingPage) return void reply(res, 500, {});

    const products: { variants: { id: string }[] }[] = [];
    for (let i = 0; i < this.variantIds.length; i += VARIANTS_PER_PRODUCT) {
      products.push({ variants: this.variantIds.slice(i, i + VARIANTS_PER_PRODUCT).map((id) => ({ id })) });
    }
    reply(res, 200, {
      items: products.slice((page - 1) * pageSize, page * pageSize),
      totalPages: Math.max(1, Math.ceil(products.length / pageSize)),
    });
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
