import { Inject, Injectable } from '@nestjs/common';
import { METRICS, type MetricsPort, type TccBranchOutcome, type TccOp } from '@jcool/metrics-port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from './ports/payment-order-repository.port';
import type {
  CancelOutcome,
  CaptureOutcome,
  OpenSessionInput,
  OpenSessionResult,
  PaymentParticipant,
  PaymentParticipantStatus,
} from './public/payment-participant.port';
import { CancelPaymentUseCase } from './use-cases/cancel-payment.use-case';
import { CapturePaymentUseCase } from './use-cases/capture-payment.use-case';
import { OpenPaymentSessionUseCase } from './use-cases/open-payment-session.use-case';

type ParticipantOutcome = OpenSessionResult['outcome'] | CaptureOutcome | CancelOutcome;

const OUTCOME_LABEL: Record<ParticipantOutcome, TccBranchOutcome> = {
  OPENED: 'opened',
  CLOSED: 'closed',
  CAPTURED: 'captured',
  IDEMPOTENT: 'idempotent',
  NOT_CAPTURABLE: 'not_capturable',
  CONFLICT: 'conflict',
  CANCELLED: 'cancelled',
  FENCED: 'fenced',
  CAPTURED_CONFLICT: 'captured_conflict',
};

@Injectable()
export class PaymentParticipantFacade implements PaymentParticipant {
  constructor(
    private readonly openPaymentSession: OpenPaymentSessionUseCase,
    private readonly capturePayment: CapturePaymentUseCase,
    private readonly cancelPayment: CancelPaymentUseCase,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
    return this.observe(
      'open_session',
      () => this.openPaymentSession.execute(input),
      (result) => result.outcome,
    );
  }

  capture({ orderId }: { orderId: string }): Promise<CaptureOutcome> {
    return this.observe(
      'capture',
      () => this.capturePayment.execute(orderId),
      (outcome) => outcome,
    );
  }

  cancel({ orderId }: { orderId: string }): Promise<CancelOutcome> {
    return this.observe(
      'cancel',
      () => this.cancelPayment.execute(orderId),
      (outcome) => outcome,
    );
  }

  async statusOf(orderIds: string[]): Promise<Map<string, PaymentParticipantStatus>> {
    if (orderIds.length === 0) return new Map();
    return this.headers.findParticipantStatuses(orderIds);
  }

  private async observe<T>(op: TccOp, run: () => Promise<T>, outcomeOf: (result: T) => ParticipantOutcome): Promise<T> {
    try {
      const result = await run();
      this.metrics.recordTccBranch('payment', op, OUTCOME_LABEL[outcomeOf(result)]);
      return result;
    } catch (error) {
      this.metrics.recordTccBranch('payment', op, 'error');
      throw error;
    }
  }
}
