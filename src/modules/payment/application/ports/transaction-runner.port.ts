import type { DrizzleTx } from '@shared/infrastructure/database';

// Unit-of-work seam. The webhook handler must log the event and change the payment atomically
// (see ProcessWebhookEventUseCase), but opening a DB transaction is an infrastructure concern —
// the application layer orchestrates through ports only. This port hands the use case a `tx` to
// thread into the repositories without letting it touch the Drizzle handle directly.
export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

export interface TransactionRunnerPort {
  /** Run `work` inside a single transaction; commit on resolve, roll back on throw. */
  run<T>(work: (tx: DrizzleTx) => Promise<T>): Promise<T>;
}
