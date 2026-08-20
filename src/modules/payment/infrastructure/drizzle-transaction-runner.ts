import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import type { TransactionRunnerPort } from '../application/ports/transaction-runner.port';

/** Drizzle adapter for TransactionRunnerPort — the only place the payment webhook flow opens a tx. */
@Injectable()
export class DrizzleTransactionRunner implements TransactionRunnerPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  run<T>(work: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
}
