import type { DrizzleTx } from '@shared/infrastructure/database';

// Unit-of-work seam: the webhook handler must log the event and change the payment atomically, and
// this hands it a `tx` to thread into the repositories without touching the Drizzle handle directly.
export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

export interface TransactionRunnerPort {
  /** Run `work` inside a single transaction; commit on resolve, roll back on throw. */
  run<T>(work: (tx: DrizzleTx) => Promise<T>): Promise<T>;
}
