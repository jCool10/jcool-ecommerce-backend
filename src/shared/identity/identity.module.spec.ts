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
import { APP_NODE_ID } from './node-ids';
import { bucketOf, decode } from './uuid-v8.codec';
import { UuidV8Generator } from './uuid-v8.generator';

const KEY = 'identity-module-spec-bucket-key-not-a-real-secret';

// Two consumers that each import IdentityModule — the shape UserModule and AuthModule have, and the
// one that would hand out two generators if the module were ever provided per importer.
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

// The metrics live in the default registry, as MetricsModule puts them there; this file asserts the
// module's binding lifecycle against them rather than the collector's own behaviour.
for (const provider of IDENTITY_CLOCK_PROVIDERS as FactoryProvider[]) {
  provider.useFactory(undefined);
}

async function driftSample(): Promise<string | undefined> {
  return (await register.metrics()).split('\n').find((line) => line.startsWith(`${ID_CLOCK_DRIFT_MS} `));
}

function build(): Promise<INestApplication> {
  return Test.createTestingModule({
    // The shipped `configuration` rather than a stub: resolving through it is what proves the
    // `identity.bucketKey` path the module reads is spelled the same in both files.
    imports: [
      ConfigModule.forRoot({ load: [configuration], ignoreEnvFile: true, isGlobal: true }),
      UserSideModule,
      AuthSideModule,
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.createNestApplication().init());
}

describe('IdentityModule', () => {
  let app: INestApplication;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env.IDENTITY_BUCKET_KEY;
    process.env.IDENTITY_BUCKET_KEY = KEY;
    app = await build();
  });

  afterEach(async () => {
    await app.close();
    if (savedKey === undefined) delete process.env.IDENTITY_BUCKET_KEY;
    else process.env.IDENTITY_BUCKET_KEY = savedKey;
  });

  // A second generator in this process would mint under the same node id and collide, and nothing
  // detects that at runtime. Asserted rather than assumed, because DI silently hands out a second
  // instance the moment the provider is re-registered in a consumer module.
  it('hands every importer the same generator', () => {
    const user = app.get(UserSideWriter);
    const auth = app.get(AuthSideWriter);

    expect(user.generator).toBe(auth.generator);
    expect(user.identity).toBe(auth.identity);
  });

  it('mints under the app node id', () => {
    const id = app.get(UserSideWriter).identity.mintUserId(normalizeEmail('node@example.com'));

    expect(decode(id).nodeId).toBe(APP_NODE_ID);
  });

  it('buckets with the configured key', () => {
    const email = normalizeEmail('Configured@Example.com');

    const id = app.get(UserSideWriter).identity.mintUserId(email);

    expect(bucketOf(id)).toBe(bucketForEmail(email, KEY));
  });

  // The gauge is registered process-wide and outlives any one app, so an app that closed without
  // releasing it would keep publishing drift for a generator nothing mints through any more.
  it('stops publishing drift once the app closes', async () => {
    await expect(driftSample()).resolves.toBeDefined();

    await app.close();

    await expect(driftSample()).resolves.toBeUndefined();

    app = await build();
  });

  // Without the key the bucket would have to be invented, and every id minted afterwards would route
  // somewhere its email does not — unrecoverably, since the bucket cannot be recomputed later.
  it('refuses to construct without a bucket key', async () => {
    await app.close();
    delete process.env.IDENTITY_BUCKET_KEY;

    await expect(build()).rejects.toThrow(/identity\.bucketKey/);

    process.env.IDENTITY_BUCKET_KEY = KEY;
    app = await build();
  });
});
