import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

/**
 * Boots the real module graph on the keyspace under `keyPrefix`; the first claim attempt has settled when
 * it resolves, but a failed one leaves the app unready until the keeper's retry lands.
 * `env` applies to this app only: config is read when the module compiles, then restored.
 */
export async function createTestApp(keyPrefix: string, env: Record<string, string> = {}): Promise<INestApplication> {
  const overrides = { ETCD_ENDPOINTS: inject('ETCD_URL'), ETCD_KEY_PREFIX: keyPrefix, ...env };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    configureApp(app);
    await app.init();
    return app;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
