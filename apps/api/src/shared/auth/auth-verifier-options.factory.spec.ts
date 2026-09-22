import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type JWK, SignJWT, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { authVerifierOptions } from './auth-verifier-options.factory';

const ISSUER = 'https://users.jcool.test';
const AUDIENCE = 'jcool-api';

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } };
}

const sign = (key: SigningKey) =>
  new SignJWT({ role: 'CUSTOMER' })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('user-1')
    .setExpirationTime('5m')
    .sign(key.privateKey);

class JwksServer {
  published: JWK[] = [];
  down = false;
  hang = false;
  requests = 0;
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer((_req, res) => {
      this.requests += 1;
      if (this.hang) return;
      if (this.down) return void res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: this.published }));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/.well-known/jwks.json`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const config = (overrides: Record<string, unknown> = {}) =>
  fakeConfigService({
    'auth.issuer': ISSUER,
    'auth.audience': AUDIENCE,
    'userService.timeoutMs': 200,
    ...overrides,
  });

const CACHE_MAX_AGE_MS = 600_000;

describe('authVerifierOptions', () => {
  describe('with a JWKS URL', () => {
    let jwks: JwksServer;
    let url: string;

    beforeEach(async () => {
      jwks = new JwksServer();
      url = await jwks.start();
    });

    afterEach(() => jwks.stop());

    const es256 = () => authVerifierOptions(config({ 'auth.jwksUrl': url })).es256;
    const verify = (token: string, { keys, issuer, audience } = es256()) =>
      jwtVerify(token, keys, { algorithms: ['ES256'], issuer, audience });

    it('verifies against the published keys, pinned to the issuer and audience', async () => {
      const key = await signingKey('k1');
      jwks.published = [key.jwk];
      const options = es256();

      await expect(verify(await sign(key), options)).resolves.toMatchObject({ payload: { sub: 'user-1' } });
      expect(options).toMatchObject({ issuer: ISSUER, audience: AUDIENCE });
    });

    it('keeps verifying from its cache while the JWKS endpoint is down', async () => {
      const key = await signingKey('k1');
      jwks.published = [key.jwk];
      const options = es256();
      await verify(await sign(key), options);

      jwks.down = true;

      await expect(verify(await sign(key), options)).resolves.toBeDefined();
      expect(jwks.requests).toBe(1);
    });

    describe('once the cache is stale', () => {
      beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
      afterEach(() => vi.useRealTimers());

      it('keeps verifying on the last keys it loaded while the endpoint is down', async () => {
        const key = await signingKey('k1');
        jwks.published = [key.jwk];
        const options = es256();
        await verify(await sign(key), options);

        jwks.down = true;
        vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1);

        await expect(verify(await sign(key), options)).resolves.toBeDefined();
        expect(jwks.requests).toBe(2);
      });

      it('leaves a failing endpoint alone for a while instead of retrying it per request', async () => {
        const key = await signingKey('k1');
        jwks.published = [key.jwk];
        const options = es256();
        await verify(await sign(key), options);
        jwks.down = true;
        vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1);
        await verify(await sign(key), options);

        await verify(await sign(key), options);
        expect(jwks.requests).toBe(2);

        jwks.down = false;
        vi.advanceTimersByTime(30_001);
        await verify(await sign(key), options);
        expect(jwks.requests).toBe(3);
      });

      it('gives up on an endpoint that never answers at the user-service timeout', async () => {
        const key = await signingKey('k1');
        jwks.published = [key.jwk];
        const options = es256();
        await verify(await sign(key), options);

        jwks.hang = true;
        vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1);

        await expect(verify(await sign(key), options)).resolves.toBeDefined();
      });

      it('stops trusting a dropped key on the first fetch that succeeds', async () => {
        const [kept, dropped] = await Promise.all([signingKey('k1'), signingKey('k2')]);
        jwks.published = [kept.jwk, dropped.jwk];
        const options = es256();
        await verify(await sign(dropped), options);

        jwks.published = [kept.jwk];
        vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1);

        await expect(verify(await sign(dropped), options)).rejects.toThrow();
        await expect(verify(await sign(kept), options)).resolves.toBeDefined();
      });
    });

    describe('on a key it has not seen', () => {
      beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
      afterEach(() => vi.useRealTimers());

      it('refetches once the cooldown has passed, and not again inside it', async () => {
        const [first, rotated, unknown] = await Promise.all([signingKey('k1'), signingKey('k2'), signingKey('k3')]);
        jwks.published = [first.jwk];
        const options = es256();
        await verify(await sign(first), options);
        jwks.published = [first.jwk, rotated.jwk];

        await expect(verify(await sign(rotated), options)).rejects.toThrow();
        expect(jwks.requests).toBe(1);

        vi.advanceTimersByTime(30_001);
        await expect(verify(await sign(rotated), options)).resolves.toBeDefined();
        expect(jwks.requests).toBe(2);

        await expect(verify(await sign(unknown), options)).rejects.toThrow();
        expect(jwks.requests).toBe(2);
      });
    });
  });
});
