import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Client } from '@temporalio/client';
import type { CheckoutSagaConfig } from '../../../../config/checkout-saga.config';
import type { OrderRefundEnginePort, RefundRunResult } from '../../application/ports/order-refund-engine.port';
import { REFUND_ORDER_WORKFLOW, refundOrderWorkflowId, type RefundOrderInput } from './refund-order.contract';
import { START_WAIT_MS } from './temporal-checkout-saga.engine';
import { isDeadlineExceeded, toEngineError, withinDeadline } from './temporal-engine-call';
import { TEMPORAL_CLIENT } from './temporal.providers';
import type { RefundOrder } from './workflows/refund-order.workflow';

const RUNNING: RefundRunResult = { outcome: 'RUNNING' };

@Injectable()
export class TemporalRefundOrderEngine implements OrderRefundEnginePort {
  private readonly config: CheckoutSagaConfig;

  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly client: Client,
    config: ConfigService,
  ) {
    this.config = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga');
  }

  async refund(orderId: string, requestedBy: string): Promise<RefundRunResult> {
    // USE_EXISTING joins an open run, whose input (and admin) wins; ALLOW_DUPLICATE opens a new run
    // over a closed one, which finds the order already refunded or the payment already refused.
    const handle = await withinDeadline(
      this.client,
      START_WAIT_MS,
      () =>
        this.client.workflow.start<typeof RefundOrder>(REFUND_ORDER_WORKFLOW, {
          workflowId: refundOrderWorkflowId(orderId),
          taskQueue: this.config.temporal.taskQueue,
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          args: [this.inputOf(orderId, requestedBy)],
        }),
      (error) => toEngineError(error, orderId, null),
    );
    try {
      return await withinDeadline(
        this.client,
        this.config.refund.waitMs,
        () => handle.result(),
        (error) => (isDeadlineExceeded(error) ? error : toEngineError(error, orderId, null)),
      );
    } catch (error) {
      // The start was confirmed, so a wait that ran out leaves the run going, not the request lost.
      if (isDeadlineExceeded(error)) return RUNNING;
      throw error;
    }
  }

  private inputOf(orderId: string, requestedBy: string): RefundOrderInput {
    const { activityTimeoutMs, retryBaseMs, retryCapMs, refund } = this.config;
    return {
      orderId,
      requestedBy,
      settings: {
        activityTimeoutMs,
        retryBaseMs,
        retryCapMs,
        pendingPollBaseMs: refund.pendingPollBaseMs,
        pendingPollMaxMs: refund.pendingPollMaxMs,
      },
    };
  }
}
