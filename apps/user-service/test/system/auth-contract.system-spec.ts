import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucketForEmail, bucketOf, decode } from '@jcool/id-codec';
import { normalizeEmail } from '@jcool/kernel';
import {
  ALLOWED_ORIGIN,
  appUrl,
  type AuthServicesStack,
  buildImages,
  IDENTITY_BUCKET_KEY,
  JWT_AUDIENCE,
  JWT_ISSUER,
  startStack,
  stopStack,
} from './auth-services-stack';

const PASSWORD = 'correct horse battery staple';

// Framing and connection headers belong to each hop; cookies are compared by attribute.
const DROPPED = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'date', 'set-cookie']);
// Different on every response by design.
const VOLATILE = /^(etag|x-request-id|x-ratelimit-(remaining|reset)(-\w+)?)$/;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

interface Answer {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: unknown;
}

type OpenApiDocument = { paths: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// 198.18.0.0/15 is reserved for benchmarking, so no real client shares a throttle key with these.
const client = (n: number) => `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`;

function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item)]));
  }
  if (typeof value !== 'string') return value;
  if (JWT.test(value)) return '<jwt>';
  if (UUID.test(value)) return '<uuid>';
  if (ISO_DATE.test(value)) return '<date>';
  return value;
}

async function read(res: Response): Promise<{ answer: Answer; body: unknown }> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not every answer is JSON.
  }
  const headers = Object.fromEntries(
    [...res.headers]
      .filter(([name]) => !DROPPED.has(name))
      .map(([name, value]) => [name, VOLATILE.test(name) ? '*' : value]),
  );
  const cookies = res.headers
    .getSetCookie()
    .map((cookie) => cookie.replace(/=[^;]*/, '=*').replace(/Expires=[^;]+/i, 'Expires=*'));
  return { answer: { status: res.status, headers, cookies, body: mask(body) }, body };
}

/** Every `/auth` operation with its schemas inlined, so two documents compare however they name components. */
function authOperations(document: OpenApiDocument): Record<string, unknown> {
  const schemas = document.components?.schemas ?? {};
  const inline = (node: unknown, seen: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => inline(item, seen));
    if (node === null || typeof node !== 'object') return node;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === 'string') {
      const name = ref.replace('#/components/schemas/', '');
      return seen.includes(name) ? { $ref: name } : inline(schemas[name], [...seen, name]);
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value, seen)]));
  };
  return Object.fromEntries(
    Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/auth/'))
      .map(([path, item]) => [path, inline(item, [])]),
  );
}

const SAMPLES: { name: string; path: string; init?: RequestInit }[] = [
  {
    name: 'a failed login',
    path: '/auth/login',
    init: json({ email: 'nobody@system-test.invalid', password: PASSWORD }),
  },
  { name: 'a session read without a token', path: '/auth/me' },
  { name: 'a session read with a forged token', path: '/auth/me', init: { headers: bearer('not.a.jwt') } },
  {
    name: 'a registration that fails validation',
    path: '/auth/register',
    init: json({ email: 'not-an-email', password: 'short' }),
  },
  {
    name: 'a registration with an unknown field',
    path: '/auth/register',
    init: json({ email: 'extra@system-test.invalid', password: PASSWORD, role: 'ADMIN' }),
  },
  { name: 'a refresh without cookies', path: '/auth/refresh', init: { method: 'POST' } },
  { name: 'a logout without a token', path: '/auth/logout', init: { method: 'POST' } },
  {
    name: 'a reset request for an unknown address',
    path: '/auth/forgot-password',
    init: json({ email: 'nobody@system-test.invalid' }),
  },
  { name: 'a verification with a bad token', path: '/auth/verify-email', init: json({ token: 'not-a-token' }) },
  { name: 'an unknown route under /auth', path: '/auth/nope' },
  {
    name: 'a CORS preflight from the allowed origin',
    path: '/auth/login',
    init: {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization,x-csrf-token',
      },
    },
  },
];

describe('user-service: the /auth contract the api serves today', () => {
  let stack: AuthServicesStack;

  beforeAll(async () => {
    await buildImages();
    stack = await startStack();
  });

  afterAll(() => stopStack(stack));

  const send = (base: 'api' | 'userService', path: string, init: RequestInit = {}, clientId = 0) => {
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', client(clientId));
    return fetch(appUrl(stack[base], path), { ...init, headers });
  };

  /** One session, start to finish, as a browser would drive it. */
  async function walkSession(base: 'api' | 'userService'): Promise<Record<string, Answer>> {
    const email = 'walk@system-test.invalid';
    const jar = new Map<string, string>();
    const steps: Record<string, Answer> = {};
    let clientId = 100;

    const step = async (name: string, path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size > 0) headers.set('cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
      const res = await send(base, path, { ...init, headers }, clientId++);
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [key, ...value] = pair.split('=');
        if (value.join('=') === '') jar.delete(key);
        else jar.set(key, value.join('='));
      }
      const { answer, body } = await read(res);
      steps[name] = answer;
      return body as { accessToken?: string };
    };
    const csrf = () => ({ 'x-csrf-token': jar.get('csrf_token') ?? '' });

    await step('register', '/auth/register', json({ email, password: PASSWORD }));
    const { accessToken: first = '' } = await step('login', '/auth/login', json({ email, password: PASSWORD }));
    await step('me', '/auth/me', { headers: bearer(first) });
    await step('sessions', '/auth/sessions', { headers: bearer(first) });
    const loginCookies = new Map(jar);
    const { accessToken: second = '' } = await step('refresh', '/auth/refresh', { method: 'POST', headers: csrf() });
    await step('me after refresh', '/auth/me', { headers: bearer(second) });
    await step('logout', '/auth/logout', { method: 'POST', headers: { ...bearer(second), ...csrf() } });
    await step('me after logout', '/auth/me', { headers: bearer(second) });
    for (const [key, value] of loginCookies) jar.set(key, value);
    await step('reuse of a rotated refresh token', '/auth/refresh', { method: 'POST', headers: csrf() });
    return steps;
  }

  it('documents every /auth operation exactly as the api does', async () => {
    const [api, userService] = await Promise.all([
      send('api', '/docs-json').then((res) => res.json() as Promise<OpenApiDocument>),
      send('userService', '/auth/docs-json').then((res) => res.json() as Promise<OpenApiDocument>),
    ]);

    expect(Object.keys(authOperations(api)).length).toBeGreaterThan(0);
    expect(authOperations(userService)).toEqual(authOperations(api));
  });

  it.each(SAMPLES.map((sample, index) => ({ ...sample, index })))(
    'answers $name as the api does',
    async ({ path, init, index }) => {
      const viaApi = await read(await send('api', path, init, index));
      const viaUserService = await read(await send('userService', path, init, index));

      expect(viaUserService.answer).toEqual(viaApi.answer);
    },
  );

  it('walks a session from registration to token reuse as the api does', async () => {
    const viaApi = await walkSession('api');
    const viaUserService = await walkSession('userService');

    expect(viaApi['reuse of a rotated refresh token'].status).toBe(401);
    expect(viaUserService).toEqual(viaApi);
  });

  it('accepts a CSRF token the api issued', async () => {
    const email = 'csrf@system-test.invalid';
    await send('api', '/auth/register', json({ email, password: PASSWORD }), 200);
    const login = await send('api', '/auth/login', json({ email, password: PASSWORD }), 201);
    const issued = login.headers
      .getSetCookie()
      .map((cookie) => /^csrf_token=([^;]+)/.exec(cookie)?.[1])
      .find(Boolean);
    expect(issued).toBeDefined();

    const refreshWith = (token: string, clientId: number) =>
      send(
        'userService',
        '/auth/refresh',
        { method: 'POST', headers: { cookie: `refresh_token=unknown; csrf_token=${token}`, 'x-csrf-token': token } },
        clientId,
      );

    // Past the CSRF guard, only to find the refresh token unknown here.
    expect((await refreshWith(issued ?? '', 202)).status).toBe(401);
    expect((await refreshWith(`${issued}x`, 203)).status).toBe(403);
  });

  it('mints user ids through the id-service behind the gateway', async () => {
    const email = 'minted@system-test.invalid';
    expect((await send('userService', '/auth/register', json({ email, password: PASSWORD }), 300)).status).toBe(201);
    const { accessToken } = (await (
      await send('userService', '/auth/login', json({ email, password: PASSWORD }), 301)
    ).json()) as { accessToken: string };
    const me = (await (await send('userService', '/auth/me', { headers: bearer(accessToken) }, 302)).json()) as {
      id: string;
    };
    const lease = (await (await fetch(appUrl(stack.idService, '/health/ready'))).json()) as {
      info: { lease: { nodeId: number } };
    };

    expect(decode(me.id).nodeId).toBe(lease.info.lease.nodeId);
    expect(bucketOf(me.id)).toBe(bucketForEmail(normalizeEmail(email), IDENTITY_BUCKET_KEY));
  });

  it('signs access tokens with a key its JWKS publishes', async () => {
    const email = 'signed@system-test.invalid';
    await send('userService', '/auth/register', json({ email, password: PASSWORD }), 400);
    const { accessToken } = (await (
      await send('userService', '/auth/login', json({ email, password: PASSWORD }), 401)
    ).json()) as { accessToken: string };
    const jwks = (await (await send('userService', '/.well-known/jwks.json')).json()) as JSONWebKeySet;

    const { payload, protectedHeader } = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ['ES256'],
    });

    expect(protectedHeader.kid).toBe('system-1');
    expect(payload.sub).toEqual(expect.any(String));
  });

  // Last: it takes the only id-service replica down.
  it('refuses a registration it cannot mint an id for, and keeps no row', async () => {
    await stack.idService.stop({ timeout: 0 });
    const email = 'unminted@system-test.invalid';

    const registration = await send('userService', '/auth/register', json({ email, password: PASSWORD }), 500);
    const login = await send('userService', '/auth/login', json({ email, password: PASSWORD }), 501);

    expect(registration.status).toBe(503);
    expect(login.status).toBe(401);
  });
});
