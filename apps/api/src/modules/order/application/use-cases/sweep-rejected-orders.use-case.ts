import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionSweepRegistry, type RetentionSweep } from '@jcool/platform/retention';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';

const DAY_MS = 86_400_000;

/**
 * A REJECTED order never reached the buyer, holds no stock and no money, and has had its idempotency
 * key cleared, so after the window only an admin investigating a failed checkout could want it.
 */
@Injectable()
export class SweepRejectedOrdersUseCase implements RetentionSweep, OnModuleInit {
  readonly name = 'order:rejected-orders';
  private readonly retentionMs: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    this.retentionMs = config.getOrThrow<number>('retention.rejectedOrderDays') * DAY_MS;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  sweep(batchSize: number): Promise<number> {
    return this.orders.deleteRejectedBefore(new Date(Date.now() - this.retentionMs), batchSize);
  }
}
