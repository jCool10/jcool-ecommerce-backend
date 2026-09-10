import { generateKeyPairSync } from 'node:crypto';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from '@shared/config/configuration';
import { DRIZZLE, PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '@shared/infrastructure/redis';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { AuthVerifyModule } from './auth-verify.module';
import { authEpochKey } from './auth-epoch.key';
import { JwtStrategy } from './jwt.strategy';

const KEY_ID = 'v1';

const keys = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Only the three commands the two Redis-backed providers issue.
class FakeRedis {
  readonly store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  exists(key: string): Promise<number> {
    return Promise.resolve(this.store.has(key) ? 1 : 0);
  }
  set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return Promise.resolve('OK');
  }
}

// AuthVerifyModule expects METRICS from the app's global registry, the way MetricsModule provides
// it — the same contract RedisSessionEpochProjection relies on in the user module.
@Global()
@Module({
  providers: [{ provide: METRICS, useValue: { recordAuthEpochProjectionMiss: () => {} } as Partial<MetricsPort> }],
  exports: [METRICS],
})
class StubMetricsModule {}

/** Drives the strategy the way passport does, so key selection and signature checking both run. */
function authenticate(strategy: JwtStrategy, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    Object.assign(strategy, {
      success: resolve,
      fail: (info: unknown) => reject(new Error(String(info))),
      error: reject,
    });
    strategy.authenticate({ headers: { authorization: `Bearer ${token}` } } as never);
  });
}

describe('AuthVerifyModule', () => {
  let app: INestApplication;
  let redis: FakeRedis;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    // The private key is deliberately absent: a verifier that could sign would not be one.
    delete process.env.JWT_ES256_PRIVATE_KEY;
    process.env.JWT_ES256_PUBLIC_KEY = keys.publicKey;
    process.env.JWT_KEY_ID = KEY_ID;

    redis = new FakeRedis();
    const moduleRef = await Test.createTestingModule({
      // The shipped `configuration`, so the config keys the strategy reads are proven spelled the
      // same in both files.
      imports: [
        ConfigModule.forRoot({ load: [configuration], ignoreEnvFile: true, isGlobal: true }),
        StubMetricsModule,
        AuthVerifyModule,
      ],
    })
      .overrideProvider(RedisService)
      .useValue({ getClient: () => redis })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    process.env = { ...savedEnv };
  });

  it('compiles with a public key and Redis alone — no database provider is reachable', () => {
    expect(app.get(JwtStrategy)).toBeDefined();
    expect(() => {
      app.get(DRIZZLE, { strict: false });
    }).toThrow();
    expect(() => {
      app.get(PG_POOL, { strict: false });
    }).toThrow();
  });

  it('holds no private key', () => {
    expect(app.get(ConfigService).get('auth.jwtPrivateKey')).toBeUndefined();
  });

  it('accepts a token signed by a key it has never seen the private half of', async () => {
    const token = await signAccess('user-1', 0);
    await redis.set(authEpochKey('user-1'), '0');

    await expect(authenticate(app.get(JwtStrategy), token)).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('rejects a token whose user has no projected epoch', async () => {
    const token = await signAccess('user-2', 0);

    await expect(authenticate(app.get(JwtStrategy), token)).rejects.toThrow();
  });
});

function signAccess(sub: string, epoch: number): Promise<string> {
  const jwt = new JwtService({
    privateKey: keys.privateKey,
    signOptions: { algorithm: 'ES256', keyid: KEY_ID, expiresIn: 300 },
  });
  return jwt.signAsync({ sub, role: 'CUSTOMER', jti: `jti-${sub}`, epoch });
}
