import { Injectable, Module, type FactoryProvider, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import configuration from '@shared/config/configuration';
import { normalizeEmail } from '@shared/kernel';
import { ID_CLOCK_DRIFT_MS, IDENTITY_CLOCK_PROVIDERS } from '@shared/observability/metrics/identity-clock.collector';
import { bucketForEmail } from './email-bucket';
import { IdentityModule } from './identity.module';
import { IdentityService } from './identity.service';
import { LEASE_PG_POOL } from './lease/lease-db.provider';
import { NODE_ID_LEASE, type NodeIdLeasePort } from './lease/node-id-lease.port';
import { bucketOf, decode } from './uuid-v8.codec';
import { UuidV8Generator } from './uuid-v8.generator';

const KEY = 'identity-module-spec-bucket-key-not-a-real-secret';
const LEASED_NODE = 7;

// The lease's own behaviour is covered by its unit and integration specs; here it only has to hand
// out one node id, so the module's wiring can be asserted without a Postgres.
const leases: NodeIdLeasePort = {
  acquire: (service) => Promise.resolve({ service, node: LEASED_NODE, leaseId: 'identity-module-spec-lease' }),
  renew: () => Promise.resolve(true),
  release: () => Promise.resolve(),
};

// The shape UserModule and AuthModule have: two consumers each importing IdentityModule, which would
// hand out two generators if the module were ever provided per importer.
@Injectable()
class UserSideWriter {
  constructor(
    readonly generator: UuidV8Generator,
    readonly identity: IdentityService,
  ) {}
}

@Module({ imports: [IdentityModule], providers: [UserSideWriter] })
class UserSideModule {}

@Injectable()
class AuthSideWriter {
  constructor(
    readonly generator: UuidV8Generator,
    readonly identity: IdentityService,
  ) {}
}

@Module({ imports: [IdentityModule], providers: [AuthSideWriter] })
class AuthSideModule {}

// Registered in the default registry, as MetricsModule does it; asserted here for the module's
// binding lifecycle, not the collector's own behaviour.
for (const provider of IDENTITY_CLOCK_PROVIDERS as FactoryProvider[]) {
  provider.useFactory(undefined);
}

async function driftSample(): Promise<string | undefined> {
  return (await register.metrics()).split('\n').find((line) => line.startsWith(`${ID_CLOCK_DRIFT_MS} `));
}

function build(): Promise<INestApplication> {
  return (
    Test.createTestingModule({
      // The shipped `configuration`, not a stub, so `identity.bucketKey` is proven spelled the same
      // in both files.
      imports: [
        ConfigModule.forRoot({ load: [configuration], ignoreEnvFile: true, isGlobal: true }),
        UserSideModule,
        AuthSideModule,
      ],
    })
      .overrideProvider(NODE_ID_LEASE)
      .useValue(leases)
      // The pool is never connected to, but the module closes it on shutdown.
      .overrideProvider(LEASE_PG_POOL)
      .useValue({ end: () => Promise.resolve(), on: () => undefined })
      .compile()
      .then((moduleRef) => moduleRef.createNestApplication().init())
  );
}

describe('IdentityModule', () => {
  let app: INestApplication;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env.IDENTITY_BUCKET_KEY;
    process.env.IDENTITY_BUCKET_KEY = KEY;
    process.env.IDENTITY_LEASE_SERVICE = 'user';
    app = await build();
  });

  afterEach(async () => {
    await app.close();
    if (savedKey === undefined) delete process.env.IDENTITY_BUCKET_KEY;
    else process.env.IDENTITY_BUCKET_KEY = savedKey;
  });

  // Two generators share this node id and collide, with nothing detecting it at runtime — and DI
  // hands out a second the moment the provider is re-registered in a consumer module.
  it('hands every importer the same generator', () => {
    const user = app.get(UserSideWriter);
    const auth = app.get(AuthSideWriter);

    expect(user.generator).toBe(auth.generator);
    expect(user.identity).toBe(auth.identity);
  });

  it('mints under the leased node id', () => {
    const id = app.get(UserSideWriter).identity.mintUserId(normalizeEmail('node@example.com'));

    expect(decode(id).nodeId).toBe(LEASED_NODE);
  });

  it('buckets with the configured key', () => {
    const email = normalizeEmail('Configured@Example.com');

    const id = app.get(UserSideWriter).identity.mintUserId(email);

    expect(bucketOf(id)).toBe(bucketForEmail(email, KEY));
  });

  // The gauge outlives any one app, so an app closing without releasing it would keep publishing
  // drift for a generator nothing mints through.
  it('stops publishing drift once the app closes', async () => {
    await expect(driftSample()).resolves.toBeDefined();

    await app.close();

    await expect(driftSample()).resolves.toBeUndefined();

    app = await build();
  });

  // Without the key the bucket would have to be invented, and the misrouting is unrecoverable —
  // the original bucket cannot be recomputed later.
  it('refuses to construct without a bucket key', async () => {
    await app.close();
    delete process.env.IDENTITY_BUCKET_KEY;

    await expect(build()).rejects.toThrow(/identity\.bucketKey/);

    process.env.IDENTITY_BUCKET_KEY = KEY;
    app = await build();
  });
});
