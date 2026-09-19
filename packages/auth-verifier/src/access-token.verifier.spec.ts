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
import { AccessTokenVerifier } from './access-token.verifier';
import type { AuthVerifierOptions } from './auth-verifier.options';
import type { SessionEpochPort } from './session-epoch.port';
import type { TokenDenylistPort } from './token-denylist.port';

const ISSUER = 'https://users.test.invalid';
const AUDIENCE = 'jcool-test';
const SECRET = randomBytes(32).toString('hex');
const USER_ID = '0197c8f4-3a1b-8c2d-8e4f-1a2b3c4d5e6f';
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

function hs256(secret: string, claims: JWTPayload = CLAIMS, expiresIn: string | number = '5m'): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

function es256(
  key: SigningKey,
  { issuer = ISSUER, audience = AUDIENCE, alg = 'ES256' }: { issuer?: string; audience?: string; alg?: string } = {},
): Promise<string> {
  return new SignJWT(CLAIMS)
    .setProtectedHeader({ alg, kid: key.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);
}

describe('AccessTokenVerifier', () => {
  let current: SigningKey;
  let previous: SigningKey;
  let epochs: { current: ReturnType<typeof vi.fn>; bump: ReturnType<typeof vi.fn> };
  let denylist: { isDenylisted: ReturnType<typeof vi.fn>; denylist: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    [current, previous] = await Promise.all([signingKey('2026-09'), signingKey('2026-03')]);
  });

  beforeEach(() => {
    epochs = { current: vi.fn().mockResolvedValue(2), bump: vi.fn() };
    denylist = { isDenylisted: vi.fn().mockResolvedValue(false), denylist: vi.fn() };
  });

  function verifier(hs256Enabled = true, overrides: Partial<AuthVerifierOptions> = {}): AccessTokenVerifier {
    const options: AuthVerifierOptions = {
      hs256: { enabled: hs256Enabled, secret: SECRET },
      es256: { keys: createLocalJWKSet({ keys: [current.jwk, previous.jwk] }), issuer: ISSUER, audience: AUDIENCE },
      ...overrides,
    };
    return new AccessTokenVerifier(
      options,
      epochs as unknown as SessionEpochPort,
      denylist as unknown as TokenDenylistPort,
    );
  }

  async function expectRefused(token: Promise<string> | string | undefined, subject = verifier(), message?: string) {
    const outcome = subject.verify(await token);
    await expect(outcome).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(outcome).rejects.toThrow(message ?? 'Unauthorized');
  }

  it('accepts an HS256 token while the legacy path is on', async () => {
    const user = await verifier().verify(await hs256(SECRET));

    expect(user).toEqual({ userId: USER_ID, role: 'CUSTOMER', jti: 'jti-1', exp: expect.any(Number) as number });
  });

  it('refuses an HS256 token once the legacy path is off', async () => {
    await expectRefused(hs256(SECRET), verifier(false));
  });

  it('accepts an ES256 token signed by the current key', async () => {
    const user = await verifier(false).verify(await es256(current));

    expect(user.userId).toBe(USER_ID);
  });

  it('accepts an ES256 token signed by the previous key during a rotation', async () => {
    await expect(verifier(false).verify(await es256(previous))).resolves.toMatchObject({ userId: USER_ID });
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

  it('refuses an HS256 token keyed with the public key', async () => {
    await expectRefused(hs256(await exportSPKI(current.publicKey)));
    await expectRefused(hs256(JSON.stringify(current.jwk)));
  });

  it('refuses an HS256 token under another secret', async () => {
    await expectRefused(hs256(randomBytes(32).toString('hex')));
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
    await expectRefused(hs256(SECRET, CLAIMS, Math.floor(Date.now() / 1000) - 1));
  });

  it.each([
    ['no subject', { role: 'CUSTOMER', jti: 'jti-1', epoch: 2 }],
    ['an unknown role', { ...CLAIMS, role: 'ROOT' }],
    ['no jti', { sub: USER_ID, role: 'CUSTOMER', epoch: 2 }],
  ])('refuses a token with %s', async (_case, claims) => {
    await expectRefused(hs256(SECRET, claims));
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

    await expectRefused(hs256(SECRET), verifier(), 'Session has been revoked');
  });

  it('reads a token without an epoch claim as epoch 0', async () => {
    const { epoch: _epoch, ...claims } = CLAIMS;
    epochs.current.mockResolvedValue(0);

    await expect(verifier().verify(await hs256(SECRET, claims))).resolves.toMatchObject({ userId: USER_ID });
  });

  it('checks no revocation state for a token it refused on signature', async () => {
    await expectRefused(hs256(randomBytes(32).toString('hex')));

    expect(denylist.isDenylisted).not.toHaveBeenCalled();
    expect(epochs.current).not.toHaveBeenCalled();
  });

  it('refuses to start with the legacy path on and no secret', () => {
    expect(() => verifier(true, { hs256: { enabled: true } })).toThrow(/HS256/);
  });
});
