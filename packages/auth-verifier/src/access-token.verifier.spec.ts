import { randomBytes } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import {
  type CryptoKey,
  type JWK,
  type JWTPayload,
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
} from 'jose';
import type { Mock } from 'vitest';
import { AccessTokenVerifier } from './access-token.verifier';
import type { AuthVerifierOptions } from './auth-verifier.options';
import type { SessionEpochReader } from './session-epoch.port';
import type { TokenDenylistReader } from './token-denylist.port';

const ISSUER = 'https://users.test.invalid';
const AUDIENCE = 'jcool-test';
const USER_ID = '137465797020397179';
const CLAIMS = { sub: USER_ID, role: 'CUSTOMER', jti: 'jti-1', epoch: 2 };

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JWK;
}

async function signingKey(kid: string, alg = 'ES256'): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  return { kid, privateKey, publicKey, jwk: { ...(await exportJWK(publicKey)), kid, alg } };
}

function hs256(secret: string, claims: JWTPayload = CLAIMS): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

interface Es256Options {
  claims?: JWTPayload;
  issuer?: string;
  audience?: string;
  alg?: string;
  expiresIn?: string | number;
}

function es256(key: SigningKey, options: Es256Options = {}): Promise<string> {
  const { claims = CLAIMS, issuer = ISSUER, audience = AUDIENCE, alg = 'ES256', expiresIn = '5m' } = options;
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: key.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key.privateKey);
}

describe('AccessTokenVerifier', () => {
  let current: SigningKey;
  let previous: SigningKey;
  // Readers only: a verifier that could write revocation state would not compile against these.
  let epochs: { current: Mock<SessionEpochReader['current']> };
  let denylist: { isDenylisted: Mock<TokenDenylistReader['isDenylisted']> };

  beforeAll(async () => {
    [current, previous] = await Promise.all([signingKey('2026-09'), signingKey('2026-03')]);
  });

  beforeEach(() => {
    epochs = { current: vi.fn<SessionEpochReader['current']>().mockResolvedValue(2) };
    denylist = { isDenylisted: vi.fn<TokenDenylistReader['isDenylisted']>().mockResolvedValue(false) };
  });

  function verifier(): AccessTokenVerifier {
    const options: AuthVerifierOptions = {
      es256: { keys: createLocalJWKSet({ keys: [current.jwk, previous.jwk] }), issuer: ISSUER, audience: AUDIENCE },
    };
    return new AccessTokenVerifier(options, epochs, denylist);
  }

  async function expectRefused(token: Promise<string> | string | undefined, subject = verifier(), message?: string) {
    const outcome = subject.verify(await token);
    await expect(outcome).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(outcome).rejects.toThrow(message ?? 'Unauthorized');
  }

  it('accepts an ES256 token signed by the current key', async () => {
    const user = await verifier().verify(await es256(current));

    expect(user).toEqual({ userId: USER_ID, role: 'CUSTOMER', jti: 'jti-1', exp: expect.any(Number) as number });
  });

  it('accepts an ES256 token signed by the previous key during a rotation', async () => {
    await expect(verifier().verify(await es256(previous))).resolves.toMatchObject({ userId: USER_ID });
  });

  it('refuses an HS256 token under any secret', async () => {
    await expectRefused(hs256(randomBytes(32).toString('hex')));
  });

  it('refuses an HS256 token keyed with the public key', async () => {
    await expectRefused(hs256(await exportSPKI(current.publicKey)));
    await expectRefused(hs256(JSON.stringify(current.jwk)));
  });

  it('refuses a key id that is not published', async () => {
    await expectRefused(es256(await signingKey('unknown')));
  });

  it('refuses a published key id over a signature from another key', async () => {
    const impostor = await signingKey(current.kid);

    await expectRefused(es256(impostor));
  });

  it('refuses an unsigned token', async () => {
    await expectRefused(new UnsecuredJWT(CLAIMS).setIssuedAt().setExpirationTime('5m').encode());
  });

  it('refuses an algorithm it has no path for', async () => {
    await expectRefused(es256(await signingKey(current.kid, 'ES384'), { alg: 'ES384' }));
  });

  it.each([
    ['issuer', { issuer: 'https://elsewhere.invalid' }],
    ['audience', { audience: 'someone-else' }],
  ])('refuses an ES256 token for another %s', async (_field, overrides) => {
    await expectRefused(es256(current, overrides));
  });

  it('refuses an expired token', async () => {
    await expectRefused(es256(current, { expiresIn: Math.floor(Date.now() / 1000) - 1 }));
  });

  it.each([
    ['no subject', { role: 'CUSTOMER', jti: 'jti-1', epoch: 2 }],
    ['an unknown role', { ...CLAIMS, role: 'ROOT' }],
    ['no jti', { sub: USER_ID, role: 'CUSTOMER', epoch: 2 }],
  ])('refuses a token with %s', async (_case, claims) => {
    await expectRefused(es256(current, { claims }));
  });

  it.each([
    ['a UUID', '0197c8f4-3a1b-8c2d-8e4f-1a2b3c4d5e6f'],
    ['an integer below the routable range', '42'],
  ])('refuses a correctly signed, unexpired token whose subject is %s', async (_case, sub) => {
    await expectRefused(es256(current, { claims: { ...CLAIMS, sub } }));

    expect(epochs.current).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'not-a-jwt'])('refuses %j as a token', async (token) => {
    await expectRefused(token);
  });

  it('refuses a denylisted token', async () => {
    denylist.isDenylisted.mockResolvedValue(true);

    await expectRefused(es256(current), verifier(), 'Token has been revoked');
    expect(denylist.isDenylisted).toHaveBeenCalledWith('jti-1');
  });

  it('refuses a token minted before the current session epoch', async () => {
    epochs.current.mockResolvedValue(3);

    await expectRefused(es256(current), verifier(), 'Session has been revoked');
    expect(epochs.current).toHaveBeenCalledWith(USER_ID);
  });

  it('refuses a token whose user is gone', async () => {
    epochs.current.mockResolvedValue(null);

    await expectRefused(es256(current), verifier(), 'Session has been revoked');
  });

  it('reads a token without an epoch claim as epoch 0', async () => {
    const { epoch: _epoch, ...claims } = CLAIMS;
    epochs.current.mockResolvedValue(0);

    await expect(verifier().verify(await es256(current, { claims }))).resolves.toMatchObject({ userId: USER_ID });
  });

  it('checks no revocation state for a token it refused on signature', async () => {
    await expectRefused(es256(await signingKey(current.kid)));

    expect(denylist.isDenylisted).not.toHaveBeenCalled();
    expect(epochs.current).not.toHaveBeenCalled();
  });
});
