import { Global, Module } from '@nestjs/common';
import { DrizzleOutboxWriter } from './outbox/drizzle-outbox.writer';
import { OUTBOX_WRITER } from './outbox/outbox-writer.port';

/**
 * Messaging infrastructure (ADR 0019). Global because any context may need to emit an event, and
 * the writer holds no per-module state — the same reasoning as MetricsModule.
 */
@Global()
@Module({
  providers: [{ provide: OUTBOX_WRITER, useClass: DrizzleOutboxWriter }],
  exports: [OUTBOX_WRITER],
})
export class MessagingModule {}
