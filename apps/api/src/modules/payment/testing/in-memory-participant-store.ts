import type { DrizzleTx } from '@shared/infrastructure/database';
import type { IdGeneratorPort } from '@shared/identity/id-generator.port';
import type { OutboxRecord, OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { Payment } from '../domain/payment.entity';
import { PaymentStatus } from '../domain/payment-status';
import { PaymentOrderStatus } from '../domain/payment-order-status';
import type {
  PaymentOrderHeader,
  PaymentOrderRepositoryPort,
} from '../application/ports/payment-order-repository.port';
import { DuplicateActivePaymentError, type PaymentRepositoryPort } from '../application/ports/payment-repository.port';
import type { TransactionRunnerPort } from '../application/ports/transaction-runner.port';

const TX = { __tx: true } as unknown as DrizzleTx;
const RETIRED = new Set<PaymentStatus>([PaymentStatus.FAILED, PaymentStatus.EXPIRED]);

export const CHARGE = { amountMinor: 150_000, currency: 'VND' } as const;

/**
 * Headers, payments and the outbox in memory, for the participant's use-case specs. A transaction
 * rolls back when its work throws, and minting an id inside one throws, so a spec fails the moment
 * a use case mints under a lock.
 */
export class InMemoryParticipantStore {
  readonly headers = new Map<string, PaymentOrderHeader>();
  readonly payments = new Map<string, Payment>();
  readonly outbox: Array<{ id?: string; record: OutboxRecord }> = [];
  /** Stand-in for `updated_at`: every write to a payment moves it to the back. */
  readonly touchedAt = new Map<string, number>();
  transactions = 0;
  private inTransaction = false;
  private nextId = 9_000;
  private clock = 0;

  readonly txRunner: TransactionRunnerPort = { run: (work) => this.transaction(work) };

  readonly idGenerator: IdGeneratorPort = {
    mint: (count = 1) => {
      if (this.inTransaction) return Promise.reject(new Error('id minted inside a transaction'));
      return Promise.resolve(Array.from({ length: count }, () => String(this.nextId++)));
    },
  };

  readonly outboxWriter: OutboxWriterPort = {
    append: (_tx, record, options) => {
      this.outbox.push({ id: options?.id, record });
      return Promise.resolve();
    },
  };

  readonly headerRepo: PaymentOrderRepositoryPort = {
    insertOpen: (_tx, { orderId, amountMinor, currency }) =>
      Promise.resolve(this.insertHeader({ orderId, status: PaymentOrderStatus.OPEN, amountMinor, currency })),
    insertFenced: (_tx, orderId) =>
      Promise.resolve(
        this.insertHeader({ orderId, status: PaymentOrderStatus.FENCED, amountMinor: null, currency: null }),
      ),
    findForUpdate: (_tx, orderId) => Promise.resolve(this.headers.get(orderId) ?? null),
    find: (orderId) => Promise.resolve(this.headers.get(orderId) ?? null),
    update: (_tx, orderId, patch) => {
      const header = this.headers.get(orderId);
      if (header) this.headers.set(orderId, { ...header, ...patch });
      return Promise.resolve();
    },
    findParticipantStatuses: () => Promise.reject(new Error('statusOf is covered end to end')),
  };

  readonly paymentRepo: PaymentRepositoryPort = {
    create: async (payment, _tx, mintedId) => {
      const active = [...this.payments.values()].find((p) => p.orderId === payment.orderId && !RETIRED.has(p.status));
      if (active) throw new DuplicateActivePaymentError(payment.orderId);
      const id = mintedId ?? (await this.idGenerator.mint(1))[0];
      return this.write(rehydrate(payment, { id }));
    },
    findByOrderId: (orderId) => Promise.resolve(this.byOrder(orderId).at(-1) ?? null),
    findByProviderSessionId: (sessionId) =>
      Promise.resolve([...this.payments.values()].find((p) => p.providerSessionId === sessionId) ?? null),
    updateStatus: (id, status, options = {}) => {
      const current = this.payments.get(id);
      if (!current || (options.expectedStatus !== undefined && current.status !== options.expectedStatus)) {
        return Promise.resolve(null);
      }
      const providerIntentId =
        options.providerIntentId === undefined ? current.providerIntentId : options.providerIntentId;
      return Promise.resolve(this.write(rehydrate(current, { status, providerIntentId })));
    },
    findActiveByOrderIdForUpdate: (_tx, orderId) =>
      Promise.resolve(this.byOrder(orderId).find((p) => !RETIRED.has(p.status)) ?? null),
    findStaleTcc: ({ limit }) => {
      const stale = [...this.payments.values()].filter((p) => {
        const header = this.headers.get(p.orderId);
        if (!header) return false;
        return (
          p.status === PaymentStatus.PENDING ||
          (p.status === PaymentStatus.AUTHORIZED &&
            (header.status === PaymentOrderStatus.CANCELLED || header.status === PaymentOrderStatus.FENCED))
        );
      });
      stale.sort((a, b) => (this.touchedAt.get(a.id as string) ?? 0) - (this.touchedAt.get(b.id as string) ?? 0));
      return Promise.resolve(stale.slice(0, limit));
    },
    bumpUpdatedAt: (id, expectedStatus) => {
      const current = this.payments.get(id);
      if (current?.status === expectedStatus) this.write(current);
      return Promise.resolve();
    },
    incrementKeyGen: (id, expectedGen) => {
      const current = this.payments.get(id);
      if (current?.stripeKeyGen !== expectedGen) return Promise.resolve(false);
      this.write(rehydrate(current, { stripeKeyGen: expectedGen + 1 }));
      return Promise.resolve(true);
    },
  };

  seedHeader(
    orderId: string,
    status: PaymentOrderStatus,
    overrides: Partial<Omit<PaymentOrderHeader, 'orderId' | 'status'>> = {},
  ): void {
    this.headers.set(orderId, { orderId, status, ...CHARGE, authorizedAt: null, ...overrides });
  }

  seedPayment(props: {
    id: string;
    orderId: string;
    status: PaymentStatus;
    sessionId?: string;
    intentId?: string | null;
    stripeKeyGen?: number;
  }): Payment {
    return this.write(
      Payment.rehydrate({
        id: props.id,
        orderId: props.orderId,
        provider: 'stripe',
        providerSessionId: props.sessionId ?? `cs_${props.id}`,
        providerIntentId: props.intentId ?? null,
        ...CHARGE,
        status: props.status,
        stripeKeyGen: props.stripeKeyGen ?? 0,
      }),
    );
  }

  /** Writes as another process would, outside any transaction of the use case under test. */
  setPaymentStatus(id: string, status: PaymentStatus, providerIntentId?: string): Payment {
    const current = this.payment(id);
    return this.write(rehydrate(current, { status, providerIntentId: providerIntentId ?? current.providerIntentId }));
  }

  payment(id: string): Payment {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`no payment ${id}`);
    return payment;
  }

  header(orderId: string): PaymentOrderHeader | undefined {
    return this.headers.get(orderId);
  }

  byOrder(orderId: string): Payment[] {
    return [...this.payments.values()].filter((p) => p.orderId === orderId);
  }

  private insertHeader(header: Omit<PaymentOrderHeader, 'authorizedAt'>): boolean {
    if (this.headers.has(header.orderId)) return false;
    this.headers.set(header.orderId, { ...header, authorizedAt: null });
    return true;
  }

  private write(payment: Payment): Payment {
    const id = payment.id as string;
    this.payments.set(id, payment);
    this.touchedAt.set(id, ++this.clock);
    return payment;
  }

  private async transaction<T>(work: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    if (this.inTransaction) throw new Error('nested transaction');
    const headers = new Map(this.headers);
    const payments = new Map(this.payments);
    const outboxLength = this.outbox.length;
    this.inTransaction = true;
    this.transactions++;
    try {
      return await work(TX);
    } catch (error) {
      replace(this.headers, headers);
      replace(this.payments, payments);
      this.outbox.length = outboxLength;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
}

function rehydrate(
  payment: Payment,
  patch: Partial<{ id: string; status: PaymentStatus; providerIntentId: string | null; stripeKeyGen: number }>,
): Payment {
  return Payment.rehydrate({
    id: patch.id ?? (payment.id as string),
    orderId: payment.orderId,
    provider: payment.provider,
    providerSessionId: payment.providerSessionId,
    providerIntentId: patch.providerIntentId === undefined ? payment.providerIntentId : patch.providerIntentId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    status: patch.status ?? payment.status,
    stripeKeyGen: patch.stripeKeyGen ?? payment.stripeKeyGen,
  });
}

function replace<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
