import { randomBytes } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import {
  type CryptoKey,
  type JWK,
  type JWTPayload,
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  errors,
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
const MALFORMED = 'token claims are malformed';

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

interface Refusal {
  /** What the client is told. */
  message?: string;
  /** Why, as logged: this package's own reason string, or the jose error class. */
  cause?: string | (abstract new (...args: never[]) => Error);
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

  async function expectRefused(token: Promise<string> | string | undefined, { message, cause }: Refusal = {}) {
    const refusal: unknown = await verifier()
      .verify(await token)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(UnauthorizedException);
    const exception = refusal as UnauthorizedException;
    expect(exception.getResponse()).toMatchObject({ message: message ?? 'Unauthorized', statusCode: 401 });
    if (typeof cause === 'string') expect((exception.cause as Error).message).toBe(cause);
    else if (cause) expect(exception.cause).toBeInstanceOf(cause);
  }

  it('accepts an ES256 token signed by the current key', async () => {
    const user = await verifier().verify(await es256(current));

    expect(user).toEqual({ userId: USER_ID, role: 'CUSTOMER', jti: 'jti-1', exp: expect.any(Number) as number });
  });

  it('accepts an ES256 token signed by the previous key during a rotation', async () => {
    await expect(verifier().verify(await es256(previous))).resolves.toMatchObject({ userId: USER_ID });
  });

  it('refuses an HS256 token keyed with the public key', async () => {
    const cause = 'no verification path for alg HS256';

    await expectRefused(hs256(await exportSPKI(current.publicKey)), { cause });
    await expectRefused(hs256(JSON.stringify(current.jwk)), { cause });
  });

  it('refuses every header alg other than ES256', async () => {
    await expectRefused(hs256(randomBytes(32).toString('hex')), { cause: 'no verification path for alg HS256' });
    await expectRefused(new UnsecuredJWT(CLAIMS).setIssuedAt().setExpirationTime('5m').encode(), {
      cause: 'no verification path for alg none',
    });
    await expectRefused(es256(await signingKey(current.kid, 'ES384'), { alg: 'ES384' }), {
      cause: 'no verification path for alg ES384',
    });
  });

  it('refuses a key id that is not published', async () => {
    await expectRefused(es256(await signingKey('unknown')), { cause: errors.JWKSNoMatchingKey });
  });

  it('refuses a published key id over a signature from another key', async () => {
    const impostor = await signingKey(current.kid);

    await expectRefused(es256(impostor), { cause: errors.JWSSignatureVerificationFailed });
  });

  it('refuses a token for another issuer or audience', async () => {
    const cause = errors.JWTClaimValidationFailed;

    await expectRefused(es256(current, { issuer: 'https://elsewhere.invalid' }), { cause });
    await expectRefused(es256(current, { audience: 'someone-else' }), { cause });
  });

  it('refuses an expired token', async () => {
    await expectRefused(es256(current, { expiresIn: Math.floor(Date.now() / 1000) - 1 }), {
      cause: errors.JWTExpired,
    });
  });

  it('refuses a token with no subject, an unknown role or no jti', async () => {
    const { sub: _sub, ...noSubject } = CLAIMS;
    const { jti: _jti, ...noJti } = CLAIMS;

    await expectRefused(es256(current, { claims: noSubject }), { cause: MALFORMED });
    await expectRefused(es256(current, { claims: { ...CLAIMS, role: 'ROOT' } }), { cause: MALFORMED });
    await expectRefused(es256(current, { claims: noJti }), { cause: MALFORMED });
  });

  // Every id column downstream throws on a non-routable id, which would surface as a 500.
  it('refuses a signed token whose subject is not a routable id', async () => {
    await expectRefused(es256(current, { claims: { ...CLAIMS, sub: '0197c8f4-3a1b-8c2d-8e4f-1a2b3c4d5e6f' } }), {
      cause: MALFORMED,
    });
    await expectRefused(es256(current, { claims: { ...CLAIMS, sub: '42' } }), { cause: MALFORMED });

    expect(epochs.current).not.toHaveBeenCalled();
  });

  it('refuses a missing or unparsable bearer token', async () => {
    await expectRefused(undefined, { cause: 'no bearer token' });
    await expectRefused('', { cause: 'no bearer token' });
    await expectRefused('not-a-jwt');
  });

  it('refuses a denylisted token', async () => {
    denylist.isDenylisted.mockResolvedValue(true);

    await expectRefused(es256(current), { message: 'Token has been revoked' });
    expect(denylist.isDenylisted).toHaveBeenCalledWith('jti-1');
  });

  it('refuses a token minted before the current session epoch', async () => {
    epochs.current.mockResolvedValue(3);

    await expectRefused(es256(current), {
      message: 'Session has been revoked',
      cause: 'token epoch is behind the session epoch',
    });
    expect(epochs.current).toHaveBeenCalledWith(USER_ID);
  });

  it('treats a token with no epoch claim as epoch 0', async () => {
    const { epoch: _epoch, ...noEpoch } = CLAIMS;
    epochs.current.mockResolvedValue(0);
    await expect(verifier().verify(await es256(current, { claims: noEpoch }))).resolves.toMatchObject({
      userId: USER_ID,
    });

    epochs.current.mockResolvedValue(1);
    await expectRefused(es256(current, { claims: noEpoch }), { message: 'Session has been revoked' });
  });

  it('refuses a token whose user is gone', async () => {
    epochs.current.mockResolvedValue(null);

    await expectRefused(es256(current), {
      message: 'Session has been revoked',
      cause: 'no session epoch for the subject',
    });
  });

  it('checks no revocation state for a token it refused on signature', async () => {
    await expectRefused(es256(await signingKey(current.kid)));

    expect(denylist.isDenylisted).not.toHaveBeenCalled();
    expect(epochs.current).not.toHaveBeenCalled();
  });
});
