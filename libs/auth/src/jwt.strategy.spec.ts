import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { createSecretOrKeyProvider, JwtStrategy } from './jwt.strategy';
import type { SessionEpochReaderPort } from './session-epoch-reader.port';
import type { TokenDenylistPort } from './token-denylist.port';

type Claims = Parameters<JwtStrategy['validate']>[0];

const KEY_ID = 'test-kid';
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeStrategy(opts: { denylisted?: boolean; currentEpoch?: number | null } = {}): JwtStrategy {
  const { denylisted = false, currentEpoch = 0 } = opts;
  const config = {
    getOrThrow: (key: string) => (key === 'auth.jwtKeyId' ? KEY_ID : publicKey),
  } as unknown as ConfigService;
  const denylist: TokenDenylistPort = {
    denylist: () => Promise.resolve(),
    isDenylisted: () => Promise.resolve(denylisted),
  };
  const sessionEpoch: SessionEpochReaderPort = { current: () => Promise.resolve(currentEpoch) };
  return new JwtStrategy(config, denylist, sessionEpoch);
}

function resolveKey(rawJwt: string): Promise<string | Buffer | undefined> {
  const provide = createSecretOrKeyProvider(new Map([[KEY_ID, publicKey]]));
  return new Promise((resolve, reject) => {
    provide(null, rawJwt, (err, key) => (err ? reject(err as Error) : resolve(key)));
  });
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signEs256(header: object, claims: object): string {
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const der = createSign('SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${der.toString('base64url')}`;
}

// The epoch read is the only stateful lookup `validate` performs; the claims are used as verified.
describe('JwtStrategy', () => {
  it('maps token claims to { userId, role, email, jti, exp } for a live token', async () => {
    const strategy = makeStrategy();
    const claims: Claims = {
      sub: 'user-1',
      role: 'ADMIN',
      email: 'a@example.com',
      jti: 'j1',
      epoch: 0,
      iat: 0,
      exp: 100,
    };

    await expect(strategy.validate(claims)).resolves.toEqual({
      userId: 'user-1',
      role: 'ADMIN',
      email: 'a@example.com',
      jti: 'j1',
      exp: 100,
    });
  });

  it('carries the CUSTOMER role through unchanged', async () => {
    const strategy = makeStrategy();
    const claims: Claims = {
      sub: 'user-2',
      role: 'CUSTOMER',
      email: 'b@example.com',
      jti: 'j2',
      epoch: 0,
      iat: 0,
      exp: 200,
    };

    await expect(strategy.validate(claims)).resolves.toMatchObject({ userId: 'user-2', role: 'CUSTOMER' });
  });

  it('accepts a token whose epoch matches the projected epoch', async () => {
    const strategy = makeStrategy({ currentEpoch: 4 });
    const claims: Claims = {
      sub: 'user-4',
      role: 'CUSTOMER',
      email: 'd@example.com',
      jti: 'j4',
      epoch: 4,
      iat: 0,
      exp: 400,
    };

    await expect(strategy.validate(claims)).resolves.toMatchObject({ userId: 'user-4' });
  });

  it('rejects a denylisted (logged-out) token with 401', async () => {
    const strategy = makeStrategy({ denylisted: true });
    const claims: Claims = {
      sub: 'user-3',
      role: 'CUSTOMER',
      email: 'c@example.com',
      jti: 'j3',
      epoch: 0,
      iat: 0,
      exp: 300,
    };

    await expect(strategy.validate(claims)).rejects.toThrow(/revoked/i);
  });

  it('rejects a token whose epoch predates the projected epoch (logout-all)', async () => {
    const strategy = makeStrategy({ currentEpoch: 2 });
    const claims: Claims = {
      sub: 'user-5',
      role: 'CUSTOMER',
      email: 'e@example.com',
      jti: 'j5',
      epoch: 1,
      iat: 0,
      exp: 500,
    };

    await expect(strategy.validate(claims)).rejects.toThrow(/revoked/i);
  });

  it('fails closed when the projection holds nothing for the user', async () => {
    const strategy = makeStrategy({ currentEpoch: null });
    const claims: Claims = {
      sub: 'gone',
      role: 'CUSTOMER',
      email: 'gone@example.com',
      jti: 'j6',
      epoch: 0,
      iat: 0,
      exp: 600,
    };

    await expect(strategy.validate(claims)).rejects.toThrow(/revoked/i);
  });

  describe('key selection', () => {
    it('resolves the public key for a token carrying the configured kid', async () => {
      const token = signEs256({ alg: 'ES256', typ: 'JWT', kid: KEY_ID }, { sub: 'user-1', jti: randomUUID() });
      await expect(resolveKey(token)).resolves.toBe(publicKey);
    });

    it('rejects a token signed under an unknown kid', async () => {
      const token = signEs256({ alg: 'ES256', typ: 'JWT', kid: 'rotated-out' }, { sub: 'user-1' });
      await expect(resolveKey(token)).rejects.toThrow(/unknown token key/i);
    });

    // An HS256 token carries no kid, so it never reaches a key at all — algorithm confusion has no
    // surface here even before `algorithms: ['ES256']` gets a chance to reject it.
    it('rejects an HS256-signed token', async () => {
      const header = b64url({ alg: 'HS256', typ: 'JWT' });
      const token = `${header}.${b64url({ sub: 'user-1' })}.not-a-real-mac`;
      await expect(resolveKey(token)).rejects.toThrow(/unknown token key/i);
    });
  });
});
