import { type KeyObject, createPrivateKey, createPublicKey } from 'node:crypto';
import type { JSONWebKeySet, JWK } from 'jose';

/**
 * `JWT_ES256_PRIVATE_KEYS` is `kid:pem[,kid:pem]`. Every listed key is published, so the one being
 * retired keeps verifying the tokens it signed; only `activeKid` signs.
 */
export class Es256SigningKeys {
  private constructor(
    readonly activeKid: string,
    readonly activeKey: KeyObject,
    readonly jwks: JSONWebKeySet,
  ) {}

  static parse(spec: string, activeKid: string): Es256SigningKeys {
    const keys = new Map<string, KeyObject>();
    for (const entry of spec.split(',').filter((part) => part.trim() !== '')) {
      const separator = entry.indexOf(':');
      const kid = entry.slice(0, Math.max(separator, 0)).trim();
      if (kid === '') throw new Error('JWT_ES256_PRIVATE_KEYS entries must be kid:pem');
      if (keys.has(kid)) throw new Error(`JWT_ES256_PRIVATE_KEYS lists kid "${kid}" twice`);
      keys.set(kid, toP256Key(kid, entry.slice(separator + 1).replace(/\\n/g, '\n')));
    }

    if (keys.size === 0) throw new Error('JWT_ES256_PRIVATE_KEYS holds no keys');
    const activeKey = keys.get(activeKid);
    if (!activeKey) throw new Error(`JWT_ES256_ACTIVE_KID "${activeKid}" is not in JWT_ES256_PRIVATE_KEYS`);

    const published = [...keys].map(([kid, key]): JWK => ({
      ...createPublicKey(key).export({ format: 'jwk' }),
      kid,
      alg: 'ES256',
      use: 'sig',
    }));
    return new Es256SigningKeys(activeKid, activeKey, { keys: published });
  }
}

function toP256Key(kid: string, pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem.trim());
  } catch (error) {
    // The parser's own message can quote the input, so it goes in `cause`, not the thrown message.
    throw new Error(`JWT_ES256_PRIVATE_KEYS: key "${kid}" is not a PEM private key`, { cause: error });
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`JWT_ES256_PRIVATE_KEYS: key "${kid}" must be an EC P-256 key`);
  }
  return key;
}
