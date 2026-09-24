import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { AccessTokenVerifier, type SessionEpochPort, type TokenDenylistPort } from '@jcool/auth-verifier';
import { Es256AccessTokenSigner } from './es256-access-token.signer';
import { Es256SigningKeys } from './es256-signing-keys';

function pem(namedCurve = 'P-256'): string {
  return generateKeyPairSync('ec', { namedCurve }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

const ISSUER = 'https://auth.jcool.test';
const AUDIENCE = 'jcool';
const CLAIMS = { sub: '137465797020397179', role: 'CUSTOMER', jti: 'jti-1', epoch: 2 } as const;

describe('Es256SigningKeys', () => {
  it('publishes every key, public half only, and signs with the active one', () => {
    const keys = Es256SigningKeys.parse(`old:${pem()},new:${pem()}`, 'new');

    expect(keys.activeKid).toBe('new');
    expect(keys.jwks.keys.map((k) => k.kid)).toEqual(['old', 'new']);
    for (const jwk of keys.jwks.keys) {
      expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      expect(jwk).not.toHaveProperty('d');
    }
  });

  // A one-line env var carries the PEM with its newlines escaped.
  it('reads PEMs whose newlines arrive escaped', () => {
    const escaped = pem().replace(/\n/g, '\\n');

    expect(Es256SigningKeys.parse(`k1:${escaped}`, 'k1').activeKid).toBe('k1');
  });

  it('refuses a key list it cannot sign with, naming what is wrong', () => {
    const cases: Record<string, [spec: string, activeKid: string, reason: RegExp]> = {
      'an empty list': ['', 'k1', /no keys/],
      'an active kid that is not configured': [`k1:${pem()}`, 'k2', /k2/],
      'a kid used twice': [`k1:${pem()},k1:${pem()}`, 'k1', /twice/],
      'an entry without a kid': [pem(), 'k1', /kid:pem/],
      'a key off P-256': [`k1:${pem('P-384')}`, 'k1', /P-256/],
      'a key that is not a key': ['k1:not-a-pem', 'k1', /k1/],
    };
    const refusal = (spec: string, activeKid: string): string => {
      try {
        Es256SigningKeys.parse(spec, activeKid);
        return 'accepted';
      } catch (error) {
        return (error as Error).message;
      }
    };

    const entries = Object.entries(cases);
    expect(Object.fromEntries(entries.map(([name, [spec, kid]]) => [name, refusal(spec, kid)]))).toEqual(
      Object.fromEntries(entries.map(([name, [, , reason]]) => [name, expect.stringMatching(reason) as unknown])),
    );
  });
});

describe('Es256AccessTokenSigner', () => {
  const options = { issuer: ISSUER, audience: AUDIENCE, expiresIn: 300 };
  const keys = Es256SigningKeys.parse(`old:${pem()},new:${pem()}`, 'new');
  const signer = new Es256AccessTokenSigner(keys, options);

  it('signs under the active kid for its issuer, audience and exact lifetime', async () => {
    const token = await signer.sign(CLAIMS);

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'new', typ: 'JWT' });
    const { payload } = await jwtVerify(token, createLocalJWKSet(keys.jwks), {
      algorithms: ['ES256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(payload).toMatchObject(CLAIMS);
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it('keeps tokens signed before a rotation verifiable after it', async () => {
    const oldPem = pem();
    const token = await new Es256AccessTokenSigner(Es256SigningKeys.parse(`old:${oldPem}`, 'old'), options).sign(
      CLAIMS,
    );
    const rotated = Es256SigningKeys.parse(`old:${oldPem},new:${pem()}`, 'new');

    await expect(
      jwtVerify(token, createLocalJWKSet(rotated.jwks), { issuer: ISSUER, audience: AUDIENCE }),
    ).resolves.toBeDefined();
  });

  it('issues what the shared verifier accepts', async () => {
    const epochs: SessionEpochPort = { current: () => Promise.resolve(2), bump: () => Promise.resolve(3) };
    const denylist: TokenDenylistPort = {
      denylist: () => Promise.resolve(),
      isDenylisted: () => Promise.resolve(false),
    };
    const verifier = new AccessTokenVerifier(
      { es256: { keys: createLocalJWKSet(keys.jwks), issuer: ISSUER, audience: AUDIENCE } },
      epochs,
      denylist,
    );

    await expect(verifier.verify(await signer.sign(CLAIMS))).resolves.toMatchObject({
      userId: CLAIMS.sub,
      role: 'CUSTOMER',
      jti: 'jti-1',
    });
  });
});
