import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import { IDEMPOTENCY_STORE, type IdempotencyStorePort } from '../ports/idempotency-store.port';

/**
 * A COMPLETED row is the frozen response a retry replays — deleting one before its TTL is up turns
 * the next retry into a second order. So the predicate is `expires_at < now` alone, never `status`.
 */
@Injectable()
export class SweepIdempotencyKeysUseCase implements RetentionSweep, OnModuleInit {
  readonly name = 'order:idempotency-keys';
  private readonly graceSec: number;

  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStorePort,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    this.graceSec = config.getOrThrow<number>('retention.idempotencyGraceSec');
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  sweep(batchSize: number): Promise<number> {
    // The key's own TTL is already the retry window; this only adds slack for a clock skew between
    // the app that stamped `expires_at` and the database that compares against it.
    return this.store.deleteExpired(new Date(Date.now() - this.graceSec * 1000), batchSize);
  }
}
