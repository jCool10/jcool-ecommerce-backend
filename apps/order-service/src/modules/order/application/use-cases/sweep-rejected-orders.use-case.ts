import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionSweepRegistry, type RetentionSweep } from '@jcool/platform/retention';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';

const DAY_MS = 86_400_000;

/** A REJECTED order was never placed for the buyer; it is kept only to explain a 409 or 503 later. */
@Injectable()
export class SweepRejectedOrdersUseCase implements RetentionSweep, OnModuleInit {
  readonly name = 'order:rejected-orders';
  private readonly retentionMs: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    this.retentionMs = config.getOrThrow<number>('retention.rejectedOrderDays') * DAY_MS;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  sweep(batchSize: number): Promise<number> {
    return this.orderRepo.deleteRejectedBefore(new Date(Date.now() - this.retentionMs), batchSize);
  }
}
