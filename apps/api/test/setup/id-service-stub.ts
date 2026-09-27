import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NODE_COUNT } from '@jcool/id-codec';
import { SnowflakeGenerator } from '@jcool/id-generator';
import { UNOWNED_BUCKET } from '../../src/shared/identity/id-generator.port';
import { currentWorkerId } from './worker-resources';

/** `hang` never answers, so the caller's timeout is what ends the call. */
export type IdServiceFault = number | 'hang';

// One node per worker: the Elasticsearch container is shared across workers.
const generator = SnowflakeGenerator.create({ nodeId: currentWorkerId() % NODE_COUNT });

/** For rows a spec writes straight to the database. Same generator as the stub, so ids never collide. */
export function testId(bucket = UNOWNED_BUCKET): string {
  return generator.generate(bucket);
}

/** Stands in for the id-service load balancer on `POST /v1/ids`. One per worker process. */
export class IdServiceStub {
  readonly buckets: number[] = [];
  private fault: IdServiceFault | undefined;
  private readonly hanging = new Set<ServerResponse>();
  private readonly server: Server = createServer((req, res) => this.handle(req, res));

  static async start(): Promise<IdServiceStub> {
    const stub = new IdServiceStub();
    await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
    stub.server.unref();
    return stub;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  fail(fault: IdServiceFault): void {
    this.fault = fault;
  }

  reset(): void {
    this.fault = undefined;
    this.buckets.length = 0;
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/ids') return void reply(res, 404, {});
      if (this.fault === 'hang') return void this.hanging.add(res);
      if (this.fault !== undefined) return void reply(res, this.fault, {});

      const { bucket, count = 1 } = JSON.parse(raw) as { bucket: number; count?: number };
      this.buckets.push(bucket);
      reply(res, 200, { ids: Array.from({ length: count }, () => generator.generate(bucket)) });
    });
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

let started: Promise<IdServiceStub> | undefined;

export function idServiceStub(): Promise<IdServiceStub> {
  started ??= IdServiceStub.start();
  return started;
}
