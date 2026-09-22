import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Role } from '@jcool/platform/rbac';
import { E2E_ES256_KID, E2E_JWT_AUDIENCE, E2E_JWT_ISSUER } from './e2e-env';

function newP256Key(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

// One per worker process: every app a spec boots must accept the tokens the others issued.
const signingKey = newP256Key();

/** `JWT_ES256_PRIVATE_KEYS` for the key this worker's apps sign with. */
export function es256KeysEnv(): string {
  return `${E2E_ES256_KID}:${signingKey.export({ format: 'pem', type: 'pkcs8' }).toString()}`;
}

export interface ForgedClaims {
  sub: string;
  role?: Role;
  epoch?: number;
}

function withClaims(claims: ForgedClaims): SignJWT {
  return new SignJWT({ role: claims.role ?? 'CUSTOMER', epoch: claims.epoch ?? 0 })
    .setSubject(claims.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('5m');
}

/** Well-formed in every claim, signed by a key the app has never published. */
export function signEs256WithForeignKey(claims: ForgedClaims, kid: string): Promise<string> {
  return withClaims(claims)
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(E2E_JWT_ISSUER)
    .setAudience(E2E_JWT_AUDIENCE)
    .sign(newP256Key());
}

/** Forged: ES256 is the only verification path, so the secret cannot matter. */
export function signHs256(claims: ForgedClaims, secret: string): Promise<string> {
  return withClaims(claims).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(new TextEncoder().encode(secret));
}
