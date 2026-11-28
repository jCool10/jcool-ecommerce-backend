import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ClsModule, ClsService } from 'nestjs-cls';
import { DrizzleOutboxWriter, MESSAGING_ID_GENERATOR, MESSAGING_OPTIONS } from '@jcool/messaging';
import { OUTBOX_WRITER } from '@jcool/messaging/outbox-port';
import { IdServiceHttpAdapter } from '@jcool/platform/identity';
import { ObservabilityLoggerModule } from '@jcool/platform/observability';
import { ConfigModule } from '@shared/config';
import { DrizzleModule } from '@shared/infrastructure/database';
import * as schema from '@shared/infrastructure/database/schema';
import { API_EVENT_ROUTES } from '@shared/messaging/event-routes';
import { publishSkuSnapshots } from './publish-sku-snapshots-runner';
import { SkuSnapshotPublisher } from './sku-snapshot.publisher';

// Deliberately not the full app, so no relay, queue consumer or sweep runs for the command's lifetime:
// the running api's relay ships what this appends. Every provider declares its dependencies through
// @Inject or a factory's `inject`, because tsx emits no decorator metadata.
@Module({
  imports: [
    ConfigModule,
    ClsModule.forRoot({ global: true }),
    ObservabilityLoggerModule,
    DrizzleModule.forRoot({ schema }),
  ],
  providers: [
    {
      provide: MESSAGING_ID_GENERATOR,
      inject: [ConfigService, ClsService],
      // One attempt, no breaker: an operator command fails on the first error and is simply run again.
      useFactory: (config: ConfigService, cls: ClsService) =>
        new IdServiceHttpAdapter(
          {
            url: config.getOrThrow<string>('idService.url'),
            timeoutMs: config.getOrThrow<number>('idService.timeoutMs'),
            caller: 'api',
          },
          { run: (task) => task() },
          cls,
        ),
    },
    { provide: MESSAGING_OPTIONS, useValue: { routes: API_EVENT_ROUTES } },
    { provide: OUTBOX_WRITER, useClass: DrizzleOutboxWriter },
    SkuSnapshotPublisher,
  ],
})
class PublishSkuSnapshotsContext {}

function parsePageSize(): number {
  const { values } = parseArgs({
    // pnpm forwards the `--` that separates its own flags from the script's.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { 'page-size': { type: 'string', default: '100' } },
  });
  const pageSize = values['page-size'];
  if (!/^[1-9]\d*$/.test(pageSize)) throw new Error(`--page-size takes a whole number from 1, got "${pageSize}"`);
  return Number(pageSize);
}

// Repeats are ignored: tsx and pnpm relay the terminal's Ctrl-C a second time.
function interruptOnSignal(): AbortSignal {
  const interrupt = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.on(name, () => {
      if (interrupt.signal.aborted) return;
      console.error(`${name} received: stopping after the current page; what was appended stays and is harmless`);
      interrupt.abort(new Error(`interrupted by ${name}`));
    });
  }
  return interrupt.signal;
}

async function publish(): Promise<void> {
  const pageSize = parsePageSize();
  const app = await NestFactory.createApplicationContext(PublishSkuSnapshotsContext, { logger: ['error', 'warn'] });
  try {
    const published = await publishSkuSnapshots(
      app.get(SkuSnapshotPublisher),
      app.get<IdServiceHttpAdapter>(MESSAGING_ID_GENERATOR),
      { pageSize, signal: interruptOnSignal() },
    );
    console.log(`Published ${published} SKU snapshots`);
  } finally {
    await app.close();
  }
}

// Explicit exit so lingering client handles (pg pool, keep-alive sockets) can't keep the process alive.
void publish()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Publishing SKU snapshots failed:', error);
    process.exit(1);
  });
