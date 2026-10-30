import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { isRoutableId } from '@jcool/id-codec';
import type { Role } from '@jcool/platform/rbac';

export interface StubUser {
  id: string;
  role: Role;
}

export type StubRoute = 'jwks' | 'epoch';

const KID = 'e2e-es256';

/**
 * Stands in for the user-service on the two paths this service calls: its JWKS and the epoch read.
 * One per worker process, started on first use. It keeps epochs in memory and never fills Redis.
 */
export class UserServiceStub {
  private readonly users = new Map<string, StubUser & { epoch: number }>();
  private readonly faults = new Map<StubRoute, number>();
  private readonly counts = new Map<StubRoute, number>();
  private readonly server: Server = createServer((req, res) => this.handle(req, res));

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly jwk: JWK,
  ) {}

  static async start(): Promise<UserServiceStub> {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const stub = new UserServiceStub(privateKey, {
      ...(await exportJWK(publicKey)),
      kid: KID,
      alg: 'ES256',
      use: 'sig',
    });
    await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
    stub.server.unref();
    return stub;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get jwksUrl(): string {
    return `${this.url}/.well-known/jwks.json`;
  }

  register(user: StubUser, epoch = 0): void {
    this.users.set(user.id, { ...user, epoch });
  }

  bumpEpoch(userId: string): number {
    const user = this.users.get(userId);
    if (!user) throw new Error(`stub has no user ${userId}`);
    user.epoch += 1;
    return user.epoch;
  }

  sign(user: StubUser, epoch = 0): Promise<string> {
    return new SignJWT({ role: user.role, epoch })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(requiredEnv('JWT_ISSUER'))
      .setAudience(requiredEnv('JWT_AUDIENCE'))
      .setSubject(user.id)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(this.privateKey);
  }

  fail(route: StubRoute, status: number): void {
    this.faults.set(route, status);
  }

  calls(route: StubRoute): number {
    return this.counts.get(route) ?? 0;
  }

  reset(): void {
    this.faults.clear();
    this.counts.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const route = routeOf(req.url ?? '');
    if (!route) return void reply(res, 404, {});
    this.counts.set(route.name, this.calls(route.name) + 1);

    const fault = this.faults.get(route.name);
    if (fault !== undefined) return void reply(res, fault, {});

    if (route.name === 'jwks') return void reply(res, 200, { keys: [this.jwk] });
    // This service calls as `inventory-service`, with the token the real allowlist names.
    if (req.headers.authorization !== `Bearer ${requiredEnv('USER_SERVICE_TOKEN')}`) return void reply(res, 401, {});
    if (!isRoutableId(route.userId)) return void reply(res, 400, {});

    const user = this.users.get(route.userId);
    if (!user) return void reply(res, 404, { statusCode: 404, message: 'Not Found' });
    reply(res, 200, { epoch: user.epoch });
  }
}

function routeOf(path: string): { name: 'jwks' } | { name: 'epoch'; userId: string } | null {
  if (path === '/.well-known/jwks.json') return { name: 'jwks' };
  const epoch = /^\/internal\/v1\/sessions\/([^/]+)\/epoch$/.exec(path);
  if (epoch) return { name: 'epoch', userId: decodeURIComponent(epoch[1]) };
  return null;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// Read per call, from the same env the app validates, so the stub can never trust a different value.
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set for the e2e run`);
  return value;
}

let started: Promise<UserServiceStub> | undefined;

export function userServiceStub(): Promise<UserServiceStub> {
  started ??= UserServiceStub.start();
  return started;
}
